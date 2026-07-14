import { resolveRef } from '../resolvers/ref';
import type {
  ContextSpec,
  OpenApiReferenceObject,
  OpenApiSchemaObject,
} from '../types';
import { isReference } from '../utils/assertion';

type SchemaOrRef = OpenApiSchemaObject | OpenApiReferenceObject;

interface ResolvedSchema {
  schema: OpenApiSchemaObject;
  ref?: string;
}

const resolveSchema = (
  schema: SchemaOrRef,
  context: ContextSpec,
): ResolvedSchema => {
  if (!isReference(schema)) {
    return { schema: schema as OpenApiSchemaObject };
  }
  const { schema: resolved } = resolveRef<OpenApiSchemaObject>(schema, context);
  return { schema: resolved, ref: schema.$ref };
};

const isDateSchema = (schema: OpenApiSchemaObject): boolean =>
  schema.format === 'date' || schema.format === 'date-time';

/**
 * True when the subtree contains at least one date field that
 * `buildDateTransformStatements` knows how to convert. Intentionally ignores
 * oneOf/anyOf and additionalProperties (MVP limitations) so a truthy result
 * always yields a non-empty deserializer.
 */
export const schemaHasDateFields = (
  schemaOrRef: SchemaOrRef,
  context: ContextSpec,
  visitedRefs: Set<string> = new Set(),
): boolean => {
  const { schema, ref } = resolveSchema(schemaOrRef, context);
  if (ref) {
    if (visitedRefs.has(ref)) return false;
    visitedRefs.add(ref);
  }

  if (isDateSchema(schema)) return true;

  if (schema.allOf) {
    return schema.allOf.some((branch) =>
      schemaHasDateFields(branch, context, visitedRefs),
    );
  }

  if (schema.items) {
    return schemaHasDateFields(schema.items, context, visitedRefs);
  }

  if (schema.properties) {
    return Object.values(schema.properties).some((property) =>
      schemaHasDateFields(property, context, visitedRefs),
    );
  }

  return false;
};

const isNullable = (schema: OpenApiSchemaObject): boolean =>
  schema.nullable === true ||
  (Array.isArray(schema.type) && schema.type.includes('null'));

const IDENTIFIER_REGEX = /^[A-Za-z_$][\w$]*$/;

const propertyAccessor = (parent: string, key: string): string =>
  IDENTIFIER_REGEX.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;

const indent = (statements: string[]): string[] =>
  statements.map((statement) => `  ${statement}`);

export interface BuildDateTransformParams {
  schema: SchemaOrRef;
  /** Expression the statements mutate in place, e.g. `data.log` */
  accessor: string;
  context: ContextSpec;
  visitedRefs?: Set<string>;
  /** Nesting level, used for unique loop index names (i0, i1, …) */
  depth?: number;
}

export const buildDateTransformStatements = ({
  schema: schemaOrRef,
  accessor,
  context,
  visitedRefs = new Set(),
  depth = 0,
}: BuildDateTransformParams): string[] => {
  const { schema, ref } = resolveSchema(schemaOrRef, context);
  if (ref) {
    if (visitedRefs.has(ref)) return [];
    visitedRefs.add(ref);
  }

  if (isDateSchema(schema)) {
    return [`${accessor} = new Date(${accessor});`];
  }

  if (schema.allOf) {
    return schema.allOf.flatMap((branch) =>
      buildDateTransformStatements({
        schema: branch,
        accessor,
        context,
        visitedRefs,
        depth,
      }),
    );
  }

  if (schema.items) {
    const index = `i${depth}`;
    const statements = buildDateTransformStatements({
      schema: schema.items,
      accessor: `${accessor}[${index}]`,
      context,
      visitedRefs,
      depth: depth + 1,
    });
    if (statements.length === 0) return [];
    return [
      `for (let ${index} = 0; ${index} < ${accessor}.length; ${index}++) {`,
      ...indent(statements),
      '}',
    ];
  }

  if (schema.properties) {
    const required = new Set(schema.required ?? []);
    return Object.entries(schema.properties).flatMap(([key, property]) => {
      const target = propertyAccessor(accessor, key);
      const statements = buildDateTransformStatements({
        schema: property,
        accessor: target,
        context,
        visitedRefs,
        depth,
      });
      if (statements.length === 0) return [];

      const { schema: propertySchema } = resolveSchema(property, context);
      const needsGuard = !required.has(key) || isNullable(propertySchema);
      if (!needsGuard) return statements;

      return [`if (${target} != null) {`, ...indent(statements), '}'];
    });
  }

  return [];
};
