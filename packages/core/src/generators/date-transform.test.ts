import { describe, expect, it } from 'vitest';

import type { ContextSpec, OpenApiSchemaObject } from '../types';
import {
  buildDateTransformStatements,
  schemaHasDateFields,
} from './date-transform';

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

  it('detects dates in a later sibling $ref after a date-free sibling $ref', () => {
    const context = makeContext({
      PlainMeta: {
        type: 'object',
        properties: { at: { type: 'string' } },
      },
      DatedMeta: {
        type: 'object',
        properties: { at: { type: 'string', format: 'date-time' } },
      },
    });
    const schema: OpenApiSchemaObject = {
      type: 'object',
      properties: {
        plain: { $ref: '#/components/schemas/PlainMeta' },
        dated: { $ref: '#/components/schemas/DatedMeta' },
      },
    };
    expect(schemaHasDateFields(schema, context)).toBe(true);
  });
});

describe('buildDateTransformStatements', () => {
  it('emits a guarded assignment for an optional date property', () => {
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['startTime'],
      properties: {
        startTime: { type: 'string', format: 'date-time' },
        endTime: { type: 'string', format: 'date-time', nullable: true },
      },
    };

    const statements = buildDateTransformStatements({
      schema,
      accessor: 'data',
      context: makeContext(),
    });

    expect(statements.join('\n')).toBe(
      [
        'data.startTime = new Date(data.startTime);',
        'if (data.endTime != null) {',
        '  data.endTime = new Date(data.endTime);',
        '}',
      ].join('\n'),
    );
  });

  it('emits an index loop for arrays so date-string elements can be reassigned', () => {
    const schema: OpenApiSchemaObject = {
      type: 'array',
      items: { type: 'string', format: 'date' },
    };

    const statements = buildDateTransformStatements({
      schema,
      accessor: 'data',
      context: makeContext(),
    });

    expect(statements.join('\n')).toBe(
      [
        'for (let i0 = 0; i0 < data.length; i0++) {',
        '  data[i0] = new Date(data[i0]);',
        '}',
      ].join('\n'),
    );
  });

  it('recurses through $ref, allOf and nested arrays, pruning date-free branches', () => {
    const context = makeContext({
      LogEvent: {
        type: 'object',
        required: ['createdAt'],
        properties: {
          createdAt: { type: 'string', format: 'date-time' },
          message: { type: 'string' },
        },
      },
    });
    const schema: OpenApiSchemaObject = {
      allOf: [
        {
          type: 'object',
          properties: {
            log: {
              type: 'array',
              items: { $ref: '#/components/schemas/LogEvent' },
            },
          },
        },
        { type: 'object', properties: { name: { type: 'string' } } },
      ],
    };

    const statements = buildDateTransformStatements({
      schema,
      accessor: 'data',
      context,
    });

    expect(statements.join('\n')).toBe(
      [
        'if (data.log != null) {',
        '  for (let i0 = 0; i0 < data.log.length; i0++) {',
        '    data.log[i0].createdAt = new Date(data.log[i0].createdAt);',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('uses bracket access for non-identifier property names', () => {
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['created-at'],
      properties: { 'created-at': { type: 'string', format: 'date-time' } },
    };

    const statements = buildDateTransformStatements({
      schema,
      accessor: 'data',
      context: makeContext(),
    });

    expect(statements).toEqual([
      'data["created-at"] = new Date(data["created-at"]);',
    ]);
  });

  it('transforms repeated sibling $refs independently', () => {
    const context = makeContext({
      Actor: {
        type: 'object',
        required: ['at'],
        properties: { at: { type: 'string', format: 'date-time' } },
      },
    });
    const schema: OpenApiSchemaObject = {
      type: 'object',
      required: ['createdBy', 'updatedBy'],
      properties: {
        createdBy: { $ref: '#/components/schemas/Actor' },
        updatedBy: { $ref: '#/components/schemas/Actor' },
      },
    };

    expect(
      buildDateTransformStatements({ schema, accessor: 'data', context }),
    ).toEqual([
      'data.createdBy.at = new Date(data.createdBy.at);',
      'data.updatedBy.at = new Date(data.updatedBy.at);',
    ]);
  });

  it('returns [] for date-free, oneOf, and circular schemas', () => {
    const context = makeContext({
      Node: {
        type: 'object',
        properties: { child: { $ref: '#/components/schemas/Node' } },
      },
    });

    expect(
      buildDateTransformStatements({
        schema: { type: 'object', properties: { name: { type: 'string' } } },
        accessor: 'data',
        context,
      }),
    ).toEqual([]);
    expect(
      buildDateTransformStatements({
        schema: {
          oneOf: [
            {
              type: 'object',
              properties: { at: { type: 'string', format: 'date-time' } },
            },
          ],
        },
        accessor: 'data',
        context,
      }),
    ).toEqual([]);
    expect(
      buildDateTransformStatements({
        schema: { $ref: '#/components/schemas/Node' },
        accessor: 'data',
        context,
      }),
    ).toEqual([]);
  });
});
