declare const contract: {
  collections: Record<
    string,
    {
      immutable: boolean;
      schema: BsonSchema;
      indexes: Array<{
        name: string;
        key: Record<string, 1 | -1>;
        unique?: boolean;
        partialFilterExpression?: Record<string, unknown>;
      }>;
    }
  >;
  legacyCollections: string[];
  validatorFor(name: string): Record<string, unknown>;
};
export interface BsonSchema {
  bsonType?: string | string[];
  properties?: Record<string, BsonSchema>;
  required?: string[];
  enum?: Array<string | number>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  multipleOf?: number;
  pattern?: string;
  items?: BsonSchema;
  minItems?: number;
  maxItems?: number;
}
export = contract;
