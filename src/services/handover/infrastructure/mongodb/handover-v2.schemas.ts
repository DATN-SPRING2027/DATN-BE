import { Schema, type SchemaDefinitionProperty } from 'mongoose';
import contract, { type BsonSchema } from './handover-v2.contract.cjs';

function property(
  field: BsonSchema,
  required: boolean,
): SchemaDefinitionProperty {
  const types = Array.isArray(field.bsonType)
    ? field.bsonType
    : [field.bsonType];
  const isNullable = types.includes('null');
  const type = types.find((value) => value !== 'null');
  let mongooseType: unknown;
  if (type === 'object') mongooseType = objectSchema(field);
  else if (type === 'array') mongooseType = [property(field.items!, false)];
  else
    mongooseType =
      {
        string: String,
        objectId: Schema.Types.ObjectId,
        date: Date,
        bool: Boolean,
        int: Number,
      }[type!] ?? Number;
  return {
    type: mongooseType,
    required: required && !isNullable && field.minLength !== 0,
    default: undefined,
    ...(field.enum ? { enum: field.enum } : {}),
    ...(field.minLength !== undefined ? { minlength: field.minLength } : {}),
    ...(field.maxLength !== undefined ? { maxlength: field.maxLength } : {}),
    ...(field.minimum !== undefined
      ? { min: field.minimum, max: field.maximum }
      : {}),
    ...(field.pattern ? { match: new RegExp(field.pattern) } : {}),
    validate: {
      validator: (value: unknown) => {
        if (value === null) return isNullable;
        if (field.multipleOf) return Number.isSafeInteger(value);
        if (Array.isArray(value))
          return (
            value.length >= (field.minItems ?? 0) &&
            value.length <= (field.maxItems ?? Infinity)
          );
        return true;
      },
      message: 'Value violates the Handover V2 storage contract',
    },
  } as SchemaDefinitionProperty;
}

function objectSchema(spec: BsonSchema, root = false): Schema {
  const fields = Object.fromEntries(
    Object.entries(spec.properties ?? {})
      .filter(([name]) => name !== '_id')
      .map(([name, field]) => [
        name,
        property(field, spec.required?.includes(name) ?? false),
      ]),
  );
  const schema = new Schema(fields, {
    _id: root,
    strict: 'throw',
    versionKey: false,
  });
  schema.pre('validate', function () {
    for (const name of spec.required ?? []) {
      if (this.get(name) === undefined)
        this.invalidate(name, 'Required storage field is missing');
    }
  });
  return schema;
}

/** Explicit model for V2; never hydrate legacy rows with invented V2 defaults. */
export function createHandoverV2Schema(
  collectionName: string,
): Schema | undefined {
  const definition = contract.collections[collectionName];
  if (!definition) return undefined;
  const schema = objectSchema(definition.schema, true);
  schema.set('collection', collectionName);
  schema.set('autoCreate', false);
  schema.set('autoIndex', false);
  schema.set(
    'timestamps',
    definition.immutable ? { createdAt: true, updatedAt: false } : true,
  );
  for (const { key, ...options } of definition.indexes)
    schema.index(key, options);
  return schema;
}

export const HANDOVER_V2_MODEL_SUFFIX = '_v2';
