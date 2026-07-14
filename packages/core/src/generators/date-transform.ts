import { resolveRef } from '../resolvers/ref';
import type {
  ContextSpec,
  GetterResponse,
  OpenApiReferenceObject,
  OpenApiSchemaObject,
} from '../types';
import { pascal } from '../utils';
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

  let result = false;
  if (isDateSchema(schema)) {
    result = true;
  } else if (schema.allOf) {
    result = schema.allOf.some((branch) =>
      schemaHasDateFields(branch, context, visitedRefs),
    );
  } else if (schema.items) {
    result = schemaHasDateFields(schema.items, context, visitedRefs);
  } else if (schema.properties) {
    result = Object.values(schema.properties).some((property) =>
      schemaHasDateFields(property, context, visitedRefs),
    );
  }

  if (ref) {
    visitedRefs.delete(ref);
  }
  return result;
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

  let result: string[] = [];
  if (isDateSchema(schema)) {
    result = [`${accessor} = new Date(${accessor});`];
  } else if (schema.allOf) {
    result = schema.allOf.flatMap((branch) =>
      buildDateTransformStatements({
        schema: branch,
        accessor,
        context,
        visitedRefs,
        depth,
      }),
    );
  } else if (schema.items) {
    const index = `i${depth}`;
    const statements = buildDateTransformStatements({
      schema: schema.items,
      accessor: `${accessor}[${index}]`,
      context,
      visitedRefs,
      depth: depth + 1,
    });
    if (statements.length > 0) {
      result = [
        `for (let ${index} = 0; ${index} < ${accessor}.length; ${index}++) {`,
        ...indent(statements),
        '}',
      ];
    }
  } else if (schema.properties) {
    const required = new Set(schema.required ?? []);
    result = Object.entries(schema.properties).flatMap(([key, property]) => {
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

  if (ref) {
    visitedRefs.delete(ref);
  }
  return result;
};

export interface GeneratedDateDeserializer {
  name: string;
  implementation: string;
}

/**
 * Builds a `deserialize{Op}Response` function converting schema-declared
 * date fields of the (single) JSON success response in place. Returns
 * undefined when there is nothing to transform, so callers emit no code.
 */
export const generateResponseDateDeserializer = ({
  operationName,
  response,
  context,
}: {
  operationName: string;
  response: GetterResponse;
  context: ContextSpec;
}): GeneratedDateDeserializer | undefined => {
  if (response.isBlob) return undefined;

  // MVP: a single success shape only — mixed 2xx types would need
  // status-aware dispatch, and the deserializer's parameter type would not
  // match the operation's return type union.
  if (response.types.success.length !== 1) return undefined;

  const [successType] = response.types.success;
  if (
    !successType.originalSchema ||
    !successType.contentType.includes('json')
  ) {
    return undefined;
  }

  const statements = buildDateTransformStatements({
    schema: successType.originalSchema,
    accessor: 'data',
    context,
  });
  if (statements.length === 0) return undefined;

  const dataType = response.definition.success || 'unknown';
  const name = `deserialize${pascal(operationName)}Response`;
  const implementation = `const ${name} = (data: ${dataType}): ${dataType} => {
  if (data == null) return data;
${indent(statements).join('\n')}
  return data;
};
`;

  return { name, implementation };
};
