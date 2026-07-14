import { describe, expect, it } from 'vitest';

import type { ContextSpec, OpenApiSchemaObject } from '../types';
import { schemaHasDateFields } from './date-transform';

const makeContext = (
  schemas: Record<string, OpenApiSchemaObject> = {},
): ContextSpec =>
  ({
    target: 'core-test',
    workspace: '/tmp',
    spec: {
      openapi: '3.0.0',
      info: { title: 'test', version: '1.0.0' },
      paths: {},
      components: { schemas },
    },
    output: { override: { useDates: true, useDatesTransform: true } },
  }) as unknown as ContextSpec;

describe('schemaHasDateFields', () => {
  it('detects a direct date-time string', () => {
    expect(
      schemaHasDateFields(
        { type: 'string', format: 'date-time' },
        makeContext(),
      ),
    ).toBe(true);
  });

  it('detects date fields through object properties and arrays', () => {
    const schema: OpenApiSchemaObject = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              createdAt: { type: 'string', format: 'date' },
            },
          },
        },
      },
    };
    expect(schemaHasDateFields(schema, makeContext())).toBe(true);
  });

  it('detects date fields through $ref and allOf', () => {
    const context = makeContext({
      Audit: {
        type: 'object',
        properties: { updatedAt: { type: 'string', format: 'date-time' } },
      },
    });
    const schema: OpenApiSchemaObject = {
      allOf: [
        { $ref: '#/components/schemas/Audit' },
        { type: 'object', properties: { name: { type: 'string' } } },
      ],
    };
    expect(schemaHasDateFields(schema, context)).toBe(true);
  });

  it('returns false for date-free subtrees', () => {
    const schema: OpenApiSchemaObject = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
      },
    };
    expect(schemaHasDateFields(schema, makeContext())).toBe(false);
  });

  it('returns false for oneOf date fields (unsupported in MVP)', () => {
    const schema: OpenApiSchemaObject = {
      oneOf: [
        {
          type: 'object',
          properties: { at: { type: 'string', format: 'date-time' } },
        },
        { type: 'string' },
      ],
    };
    expect(schemaHasDateFields(schema, makeContext())).toBe(false);
  });

  it('terminates on circular $refs', () => {
    const context = makeContext({
      Node: {
        type: 'object',
        properties: {
          child: { $ref: '#/components/schemas/Node' },
          label: { type: 'string' },
        },
      },
    });
    expect(
      schemaHasDateFields({ $ref: '#/components/schemas/Node' }, context),
    ).toBe(false);
  });
});
