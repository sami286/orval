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
