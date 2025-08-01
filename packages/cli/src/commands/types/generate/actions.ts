import { compile, type JSONSchema } from 'json-schema-to-typescript';
import type { SpaceComponent, SpaceComponentsData } from '../../../commands/components/constants';
import { __dirname, capitalize, handleError, handleFileSystemError, toCamelCase, toPascalCase } from '../../../utils';
import type { GenerateTypesOptions } from './constants';
import type { StoryblokPropertyType } from '../../../types/storyblok';
import { storyblokSchemas } from '../../../utils/storyblok-schemas';
import { join, resolve } from 'node:path';
import { resolvePath, saveToFile } from '../../../utils/filesystem';
import { readFileSync } from 'node:fs';
import type { ComponentPropertySchema } from '../../../types/schemas';

export interface ComponentGroupsAndNamesObject {
  componentGroups: Map<string, Set<string>>;
  componentNames: Set<string>;
}

// Constants
const STORY_TYPE = 'ISbStoryData';
const DEFAULT_TYPEDEFS_HEADER = [
  '// This file was generated by the storyblok CLI.',
  '// DO NOT MODIFY THIS FILE BY HAND.',
];

const getPropertyTypeAnnotation = (property: ComponentPropertySchema, prefix?: string, suffix?: string) => {
  // If a property type is one of the ones provided by Storyblok, return that type
  // Casting as string[] to avoid TS error on using Array.includes on different narrowed types
  if (Array.from(storyblokSchemas.keys()).includes(property.type as StoryblokPropertyType)) {
    return { type: property.type };
  }
  // Initialize property type as any (fallback type)
  let type: string | string[] = 'unknown';

  const options = property.options && property.options.length > 0 ? property.options.map((item: { value: string }) => item.value) : [];

  // Add empty option to options array
  if (options.length > 0 && property.exclude_empty_option !== true) {
    options.unshift('');
  }

  if (property.source === 'internal_stories') {
    // Only if there is a filter_content_type, we can return a proper type
    if (property.filter_content_type) {
      if (typeof property.filter_content_type === 'string') {
        return {
          tsType: `(${getStoryType(property.filter_content_type, prefix, suffix)} | string )${property.type === 'options' ? '[]' : ''}`,
        };
      }

      return {
        tsType: `(${property.filter_content_type
          .map(type2 => getStoryType(type2, prefix, suffix))
          // In this case property.type can be `option` or `options`. In case of `options` the type should be an array
          .join(' | ')} | string )${property.type === 'options' ? '[]' : ''}`,
      };
    }
  }

  if (
    // If there is no `source` and there are options, the data source is the component itself
    // TODO: check if this is an old behaviour (shouldn't this be handled as an "internal" source?)
    (options.length > 0 && !property.source)
    || property.source === 'internal_languages'
    || property.source === 'external'
  ) {
    type = 'string';
  }

  if (property.source === 'internal') {
    type = ['number', 'string'];
  }

  if (property.type === 'option') {
    if (options.length > 0) {
      return {
        type,
        enum: options,
      };
    }

    return {
      type,
    };
  }

  if (property.type === 'options') {
    if (options.length > 0) {
      return {
        type: 'array',
        items: {
          enum: options,
        },
      };
    }

    return {
      type: 'array',
      items: { type },
    };
  }

  switch (property.type) {
    case 'bloks':
      return { type: 'array' };
    case 'boolean':
      return { type: 'boolean' };
    case 'datetime':
    case 'image':
    case 'markdown':
    case 'number':
    case 'text':
    case 'textarea':
      return { type: 'string' };
    default:
      return { type: 'any' };
  }
};

export function getStoryType(property: string, prefix?: string, suffix?: string) {
  return `${STORY_TYPE}<${prefix ?? ''}${capitalize(toCamelCase(property))}${suffix ?? ''}>`;
}

/**
 * Generates a TypeScript type name for a component
 * @param componentName - The name of the component
 * @param options - Options for generating the type name
 * @returns The generated type name
 *
 * The type name can be customized with the following options:
 * - typePrefix: Prefix to be prepended to all generated component type names (can be set via --type-prefix flag)
 */
export const getComponentType = (
  componentName: string,
  options: GenerateTypesOptions,
): string => {
  const prefix = options.typePrefix ?? '';
  const suffix = options.typeSuffix ?? '';

  // Sanitize the component name to handle special characters and emojis
  const sanitizedName = componentName
    // Replace any character that's not a letter or number with an underscore
    .replace(/[^a-z0-9]/gi, '_')
    // Replace multiple consecutive underscores with a single underscore
    .replace(/_+/g, '_')
    // Trim underscores from the beginning and end
    .replace(/^_+|_+$/g, '');

  // Convert to PascalCase
  const componentType = toPascalCase(toCamelCase(`${prefix}_${sanitizedName}_${suffix}`));

  // If the component type starts with a number, prefix it with an underscore
  const isFirstCharacterNumber = !Number.isNaN(Number.parseInt(componentType.charAt(0)));
  return isFirstCharacterNumber ? `_${componentType}` : componentType;
};

const getComponentPropertiesTypeAnnotations = async (
  component: SpaceComponent,
  options: GenerateTypesOptions,
  spaceData: SpaceComponentsData,
  customFieldsParser?: (key: string, value: Record<string, unknown>) => Record<string, unknown>,
): Promise<JSONSchema['properties']> => {
  return Object.entries<Record<string, any>>(component.schema).reduce(async (accPromise, [key, value]) => {
    const acc = await accPromise;

    // Skip tabbed properties
    if (key.startsWith('tab-')) {
      return acc;
    }

    const propertyType = value.type;
    const propertyTypeAnnotation: JSONSchema = {
      [key]: getPropertyTypeAnnotation(value as ComponentPropertySchema, options.typePrefix, options.typeSuffix),
    };

    if (propertyType === 'custom' && customFieldsParser) {
      const customField = typeof customFieldsParser === 'function' ? customFieldsParser(key, value) : {};
      return {
        ...acc,
        ...customField,
      };
    }

    if (Array.from(storyblokSchemas.keys()).includes(propertyType as StoryblokPropertyType)) {
      // For Storyblok property types, don't apply the prefix
      const componentType = toPascalCase(toCamelCase(propertyType));
      propertyTypeAnnotation[key].tsType = `Storyblok${componentType}`;
    }

    if (propertyType === 'multilink') {
      const excludedLinktypes: string[] = [
        ...(!value.email_link_type ? ['{ linktype?: "email" }'] : []),
        ...(!value.asset_link_type ? ['{ linktype?: "asset" }'] : []),
      ];
      const componentType = toPascalCase(toCamelCase(propertyType));
      propertyTypeAnnotation[key].tsType
        = excludedLinktypes.length > 0 ? `Exclude<Storyblok${componentType}, ${excludedLinktypes.join(' | ')}>` : componentType;
    }

    if (propertyType === 'bloks') {
      if (value.restrict_components) {
        // Components restricted by groups
        if (value.restrict_type === 'groups') {
          if (
            Array.isArray(value.component_group_whitelist)
            && value.component_group_whitelist.length > 0
          ) {
            // Find components that belong to the whitelisted groups
            const componentsInGroupWhitelist = value.component_group_whitelist.reduce(
              (components: string[], groupUUID: string) => {
                // Find components that have this group UUID
                const componentsInGroup = spaceData.components.filter(
                  component => component.component_group_uuid === groupUUID,
                );

                return componentsInGroup.length > 0
                  ? [
                      ...components,
                      ...componentsInGroup.map(component => getComponentType(component.name, options)),
                    ]
                  : components;
              },
              [],
            );

            propertyTypeAnnotation[key].tsType
              = componentsInGroupWhitelist.length > 0 ? `(${componentsInGroupWhitelist.join(' | ')})[]` : `never[]`;
          }
        }
        else {
          // Components restricted by 1-by-1 list
          if (Array.isArray(value.component_whitelist) && value.component_whitelist.length > 0) {
            propertyTypeAnnotation[key].tsType = `(${value.component_whitelist
              .map((name: string) => getComponentType(name, options))
              .join(' | ')})[]`;
          }
        }
      }
      else {
        // All components can be slotted in this property (AKA no restrictions)
        // Add null check to ensure spaceData.components is defined
        if (spaceData && Array.isArray(spaceData.components)) {
          propertyTypeAnnotation[key].tsType = `(${spaceData.components
            .map(component => getComponentType(component.name, options))
            .join(' | ')})[]`;
        }
        else {
          // Fallback to never[] if components is undefined
          propertyTypeAnnotation[key].tsType = `never[]`;
        }
      }
    }

    return { ...acc, ...propertyTypeAnnotation };
  }, Promise.resolve({} as JSONSchema));
};

const loadCustomFieldsParser = async (path: string): Promise<((key: string, value: Record<string, unknown>) => Record<string, unknown>) | undefined> => {
  try {
    const customFieldsParser = await import(resolve(path));
    return customFieldsParser.default;
  }
  catch (error) {
    handleError(error as Error);
    return undefined;
  }
};

async function loadCompilerOptions(path: string) {
  if (path) {
    const compilerOptions = await import(resolve(path));
    return compilerOptions.default;
  }
  return {};
}

export const generateTypes = async (
  spaceData: SpaceComponentsData,
  options: GenerateTypesOptions = {
    strict: false,
  },
) => {
  try {
    const typeDefs = [...DEFAULT_TYPEDEFS_HEADER];
    const storyblokPropertyTypes = new Set<string>();
    let customFieldsParser: ((key: string, value: Record<string, unknown>) => Record<string, unknown>) | undefined;
    let compilerOptions: Record<string, unknown> | undefined;
    // Custom fields parser
    if (options.customFieldsParser) {
      customFieldsParser = await loadCustomFieldsParser(options.customFieldsParser);
    }

    // Compiler options
    if (options.compilerOptions) {
      compilerOptions = await loadCompilerOptions(options.compilerOptions);
    }

    const schemas = await Promise.all(spaceData.components.map(async (component) => {
    // Get the component type name with proper handling of numbers at the start
      const type = getComponentType(component.name, options);
      const componentPropertiesTypeAnnotations = await getComponentPropertiesTypeAnnotations(component, options, spaceData, customFieldsParser);
      const requiredFields = Object.entries<Record<string, any>>(component?.schema || {}).reduce(
        (acc, [key, value]) => {
          if (value.required) {
            return [...acc, key];
          }
          return acc;
        },
        ['component', '_uid'],
      );

      // Check if any property has a type that's in storyblokSchemas.keys()
      if (componentPropertiesTypeAnnotations) {
        Object.entries(componentPropertiesTypeAnnotations).forEach(([_, property]) => {
          if (property.type && Array.from(storyblokSchemas.keys()).includes(property.type as StoryblokPropertyType)) {
            storyblokPropertyTypes.add(property.type as StoryblokPropertyType);
          }
          // Check if the property uses ISbStoryData
          if (property.tsType && property.tsType.includes(STORY_TYPE)) {
            storyblokPropertyTypes.add(STORY_TYPE);
          }
        });
      }

      const componentSchema: JSONSchema = {
        $id: `#/${component.name}`,
        title: type, // This is the key - we're using the properly formatted type name
        type: 'object',
        required: requiredFields,
        properties: {
          ...componentPropertiesTypeAnnotations,
          component: {
            type: 'string',
            enum: [component.name],
          },
          _uid: {
            type: 'string',
          },
        },
      };

      return componentSchema;
    }));

    const result = await Promise.all(schemas.map(async (schema) => {
    // Use the title as the interface name
      return await compile(schema, schema.title || schema.$id.replace('#/', ''), {
        additionalProperties: !options.strict,
        bannerComment: '',
        ...compilerOptions,
      });
    }));

    // Add imports for Storyblok types if needed
    const imports: string[] = [];

    // Check if ISbStoryData is needed
    const needsISbStoryData = storyblokPropertyTypes.has(STORY_TYPE);
    if (needsISbStoryData) {
      imports.push(`import type { ${STORY_TYPE} } from '@storyblok/js';`);
      storyblokPropertyTypes.delete(STORY_TYPE); // Remove it so it's not included in the next import
    }

    if (storyblokPropertyTypes.size > 0) {
      const typeImports = Array.from(storyblokPropertyTypes).map((type) => {
        const pascalType = toPascalCase(type);
        return `Storyblok${pascalType}`;
      });

      imports.push(`import type { ${typeImports.join(', ')} } from '../storyblok.d.ts';`);
    }

    const finalTypeDef = [...typeDefs, ...imports, ...result];

    return [
      ...finalTypeDef,
    ].join('\n');
  }
  catch (error) {
    handleError(error as Error);
  }
};

export const saveTypesToFile = async (space: string, typedefString: string, options: SaveTypesOptions) => {
  const { filename = 'storyblok-components', path } = options;
  // Ensure we always include the components/space folder structure regardless of custom path
  const resolvedPath = path
    ? resolve(process.cwd(), path, 'types', space)
    : resolvePath(path, `types/${space}`);

  try {
    await saveToFile(join(resolvedPath, `${filename}.d.ts`), typedefString);
  }
  catch (error) {
    handleFileSystemError('write', error as Error);
  }
};

// Add SaveTypesOptions interface
export interface SaveTypesOptions {
  filename?: string;
  path?: string;
}

/**
 * Generates a d.ts file with the Storyblok type definitions
 * @param options - Options for generating the types
 * @returns Promise that resolves when the file is saved
 */
export const generateStoryblokTypes = async (options: SaveTypesOptions = {}) => {
  const { filename = 'storyblok', path } = options;

  try {
    // Get the path to the storyblok.ts file

    const storyblokTypesPath = resolve(__dirname, './index.d.ts');
    // Read the content of the storyblok.ts file
    const storyblokTypesContent = readFileSync(storyblokTypesPath, 'utf-8');

    // Define the content of the d.ts file
    const typeDefs = [
      '// This file was generated by the Storyblok CLI.',
      '// DO NOT MODIFY THIS FILE BY HAND.',
      `import type { ${STORY_TYPE} } from '@storyblok/js';`,
      storyblokTypesContent,
    ].join('\n');

    // Determine the path to save the file
    const resolvedPath = path
      ? resolve(process.cwd(), path, 'types')
      : resolvePath(path, 'types');

    await saveToFile(join(resolvedPath, `${filename}.d.ts`), typeDefs);
    return true;
  }
  catch (error) {
    handleFileSystemError('read', error as Error);
    return false;
  }
};
