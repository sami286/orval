import { describe, expect, it } from 'vitest';

import type {
  ContextSpec,
  GetterResponse,
  OpenApiSchemaObject,
} from '../types';
import {
  buildDateTransformStatements,
  generateResponseDateDeserializer,
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

  it('hoists array items into a const so optional-date narrowing survives', () => {
    const schema: OpenApiSchemaObject = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          resolvedAt: { type: 'string', format: 'date-time' },
        },
      },
    };

    const statements = buildDateTransformStatements({
      schema,
      accessor: 'data',
      context: makeContext(),
    });

    expect(statements.join('\n')).toBe(
      [
        'for (let i0 = 0; i0 < data.length; i0++) {',
        '  const item0 = data[i0];',
        '  if (item0.resolvedAt != null) {',
        '    item0.resolvedAt = new Date(item0.resolvedAt);',
        '  }',
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
        '    const item0 = data.log[i0];',
        '    item0.createdAt = new Date(item0.createdAt);',
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

  it('applies allOf branches and sibling properties together', () => {
    const context = makeContext({
      Audit: {
        type: 'object',
        required: ['updatedAt'],
        properties: { updatedAt: { type: 'string', format: 'date-time' } },
      },
    });
    const schema: OpenApiSchemaObject = {
      allOf: [{ $ref: '#/components/schemas/Audit' }],
      required: ['createdAt'],
      properties: { createdAt: { type: 'string', format: 'date-time' } },
    };

    expect(
      buildDateTransformStatements({ schema, accessor: 'data', context }),
    ).toEqual([
      'data.updatedAt = new Date(data.updatedAt);',
      'data.createdAt = new Date(data.createdAt);',
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

describe('buildDateTransformStatements — discriminated unions', () => {
  const makeUnionContext = () =>
    makeContext({
      EnglishDetails: {
        type: 'object',
        required: ['startTime'],
        properties: {
          startTime: { type: 'string', format: 'date-time' },
        },
      },
      DutchDetails: {
        type: 'object',
        properties: {
          endTime: { type: 'string', format: 'date-time', nullable: true },
        },
      },
    });

  it('emits a switch with one case per mapping key, in mapping order', () => {
    const context = makeUnionContext();
    const schema: OpenApiSchemaObject = {
      oneOf: [
        { $ref: '#/components/schemas/EnglishDetails' },
        { $ref: '#/components/schemas/DutchDetails' },
      ],
      discriminator: {
        propertyName: 'auctionType',
        mapping: {
          reverse_english_auction: '#/components/schemas/EnglishDetails',
          dutch_auction: '#/components/schemas/DutchDetails',
        },
      },
    };

    const statements = buildDateTransformStatements({
      schema,
      accessor: 'data',
      context,
    });

    expect(statements.join('\n')).toBe(
      [
        'switch (data.auctionType) {',
        "  case 'reverse_english_auction': {",
        '    data.startTime = new Date(data.startTime);',
        '    break;',
        '  }',
        "  case 'dutch_auction': {",
        '    if (data.endTime != null) {',
        '      data.endTime = new Date(data.endTime);',
        '    }',
        '    break;',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('emits identical case bodies when two mapping keys point at the same ref', () => {
    const context = makeUnionContext();
    const schema: OpenApiSchemaObject = {
      oneOf: [{ $ref: '#/components/schemas/DutchDetails' }],
      discriminator: {
        propertyName: 'auctionType',
        mapping: {
          dutch_auction: '#/components/schemas/DutchDetails',
          japanese_auction: '#/components/schemas/DutchDetails',
        },
      },
    };

    const statements = buildDateTransformStatements({
      schema,
      accessor: 'data',
      context,
    });

    expect(statements.join('\n')).toBe(
      [
        'switch (data.auctionType) {',
        "  case 'dutch_auction': {",
        '    if (data.endTime != null) {',
        '      data.endTime = new Date(data.endTime);',
        '    }',
        '    break;',
        '  }',
        "  case 'japanese_auction': {",
        '    if (data.endTime != null) {',
        '      data.endTime = new Date(data.endTime);',
        '    }',
        '    break;',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('omits a case for a mapping key whose variant has no dates', () => {
    const context = makeContext({
      EnglishDetails: {
        type: 'object',
        required: ['startTime'],
        properties: {
          startTime: { type: 'string', format: 'date-time' },
        },
      },
      DateFree: {
        type: 'object',
        properties: { name: { type: 'string' } },
      },
    });
    const schema: OpenApiSchemaObject = {
      oneOf: [
        { $ref: '#/components/schemas/EnglishDetails' },
        { $ref: '#/components/schemas/DateFree' },
      ],
      discriminator: {
        propertyName: 'auctionType',
        mapping: {
          reverse_english_auction: '#/components/schemas/EnglishDetails',
          date_free: '#/components/schemas/DateFree',
        },
      },
    };

    const statements = buildDateTransformStatements({
      schema,
      accessor: 'data',
      context,
    });

    expect(statements.join('\n')).toBe(
      [
        'switch (data.auctionType) {',
        "  case 'reverse_english_auction': {",
        '    data.startTime = new Date(data.startTime);',
        '    break;',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  it('returns [] when every mapped variant is date-free', () => {
    const context = makeContext({
      DateFreeA: {
        type: 'object',
        properties: { name: { type: 'string' } },
      },
      DateFreeB: {
        type: 'object',
        properties: { label: { type: 'string' } },
      },
    });
    const schema: OpenApiSchemaObject = {
      oneOf: [
        { $ref: '#/components/schemas/DateFreeA' },
        { $ref: '#/components/schemas/DateFreeB' },
      ],
      discriminator: {
        propertyName: 'kind',
        mapping: {
          a: '#/components/schemas/DateFreeA',
          b: '#/components/schemas/DateFreeB',
        },
      },
    };

    expect(
      buildDateTransformStatements({ schema, accessor: 'data', context }),
    ).toEqual([]);
  });

  it('returns [] for oneOf with a discriminator but no mapping', () => {
    const context = makeUnionContext();
    const schema: OpenApiSchemaObject = {
      oneOf: [{ $ref: '#/components/schemas/EnglishDetails' }],
      discriminator: {
        propertyName: 'auctionType',
      },
    };

    expect(
      buildDateTransformStatements({ schema, accessor: 'data', context }),
    ).toEqual([]);
  });

  it('wraps a discriminated union nested under an optional property in the property guard', () => {
    const context = makeUnionContext();
    const schema: OpenApiSchemaObject = {
      type: 'object',
      properties: {
        details: {
          oneOf: [
            { $ref: '#/components/schemas/EnglishDetails' },
            { $ref: '#/components/schemas/DutchDetails' },
          ],
          discriminator: {
            propertyName: 'auctionType',
            mapping: {
              reverse_english_auction: '#/components/schemas/EnglishDetails',
              dutch_auction: '#/components/schemas/DutchDetails',
            },
          },
        },
      },
    };

    const statements = buildDateTransformStatements({
      schema,
      accessor: 'data',
      context,
    });

    expect(statements.join('\n')).toBe(
      [
        'if (data.details != null) {',
        '  switch (data.details.auctionType) {',
        "    case 'reverse_english_auction': {",
        '      data.details.startTime = new Date(data.details.startTime);',
        '      break;',
        '    }',
        "    case 'dutch_auction': {",
        '      if (data.details.endTime != null) {',
        '        data.details.endTime = new Date(data.details.endTime);',
        '      }',
        '      break;',
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );
  });
});

const makeResponse = (
  overrides: Partial<GetterResponse> & {
    successTypes?: Array<Partial<GetterResponse['types']['success'][number]>>;
  },
): GetterResponse => {
  const { successTypes, ...rest } = overrides;
  return {
    imports: [],
    definition: { success: 'Pet', errors: 'unknown' },
    isBlob: false,
    types: {
      success: (successTypes ?? []).map((type) => ({
        value: 'Pet',
        isEnum: false,
        type: 'object',
        imports: [],
        schemas: [],
        isRef: true,
        key: '200',
        contentType: 'application/json',
        ...type,
      })),
      errors: [],
    },
    contentTypes: ['application/json'],
    schemas: [],
    ...rest,
  } as GetterResponse;
};

describe('generateResponseDateDeserializer', () => {
  const datedSchema: OpenApiSchemaObject = {
    type: 'object',
    required: ['createdAt'],
    properties: { createdAt: { type: 'string', format: 'date-time' } },
  };

  it('generates a named deserializer for a dated JSON response', () => {
    const result = generateResponseDateDeserializer({
      operationName: 'getPet',
      response: makeResponse({
        successTypes: [{ originalSchema: datedSchema }],
      }),
      context: makeContext(),
    });

    expect(result?.name).toBe('deserializeGetPetResponse');
    expect(result?.implementation).toBe(
      `const deserializeGetPetResponse = (data: Pet): Pet => {
  if (data == null) return data;
  data.createdAt = new Date(data.createdAt);
  return data;
};
`,
    );
  });

  it('generates a deserializer with a discriminator switch for a discriminated-union response', () => {
    const context = makeContext({
      EnglishDetails: {
        type: 'object',
        required: ['startTime'],
        properties: {
          startTime: { type: 'string', format: 'date-time' },
        },
      },
      DutchDetails: {
        type: 'object',
        properties: {
          endTime: { type: 'string', format: 'date-time', nullable: true },
        },
      },
    });
    const unionSchema: OpenApiSchemaObject = {
      oneOf: [
        { $ref: '#/components/schemas/EnglishDetails' },
        { $ref: '#/components/schemas/DutchDetails' },
      ],
      discriminator: {
        propertyName: 'auctionType',
        mapping: {
          reverse_english_auction: '#/components/schemas/EnglishDetails',
          dutch_auction: '#/components/schemas/DutchDetails',
        },
      },
    };

    const result = generateResponseDateDeserializer({
      operationName: 'getAuctionSummary',
      response: makeResponse({
        successTypes: [{ originalSchema: unionSchema }],
      }),
      context,
    });

    expect(result?.name).toBe('deserializeGetAuctionSummaryResponse');
    expect(result?.implementation).toContain('switch (data.auctionType) {');
  });

  it('generates a deserializer for an uppercase JSON content type', () => {
    const result = generateResponseDateDeserializer({
      operationName: 'getPet',
      response: makeResponse({
        successTypes: [
          { originalSchema: datedSchema, contentType: 'application/JSON' },
        ],
      }),
      context: makeContext(),
    });

    expect(result?.name).toBe('deserializeGetPetResponse');
  });

  it('returns undefined when the response has no date fields', () => {
    const result = generateResponseDateDeserializer({
      operationName: 'getPet',
      response: makeResponse({
        successTypes: [
          {
            originalSchema: {
              type: 'object',
              properties: { name: { type: 'string' } },
            },
          },
        ],
      }),
      context: makeContext(),
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined for blob, non-JSON, missing-schema and multi-success responses', () => {
    const context = makeContext();
    const blob = makeResponse({
      successTypes: [{ originalSchema: datedSchema }],
    });
    blob.isBlob = true;
    expect(
      generateResponseDateDeserializer({
        operationName: 'a',
        response: blob,
        context,
      }),
    ).toBeUndefined();
    expect(
      generateResponseDateDeserializer({
        operationName: 'b',
        response: makeResponse({
          successTypes: [
            { originalSchema: datedSchema, contentType: 'text/plain' },
          ],
        }),
        context,
      }),
    ).toBeUndefined();
    expect(
      generateResponseDateDeserializer({
        operationName: 'c',
        response: makeResponse({ successTypes: [{}] }),
        context,
      }),
    ).toBeUndefined();
    expect(
      generateResponseDateDeserializer({
        operationName: 'd',
        response: makeResponse({
          successTypes: [
            { originalSchema: datedSchema },
            { key: '201', originalSchema: datedSchema },
          ],
        }),
        context,
      }),
    ).toBeUndefined();
  });
});
