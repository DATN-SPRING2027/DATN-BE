export const MAX_SCHEMA_DEPTH = 32;

const FORBIDDEN_OWN_PROPERTIES = [
  '__proto__',
  'constructor',
  'prototype',
] as const;

const FORBIDDEN_OWN_PROPERTY_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_OWN_PROPERTIES,
);

const PATTERN_REGEX_CACHE = new Map<string, RegExp>();
const MAX_PATTERN_CACHE_ENTRIES = 512;

export interface McpSchemaValidationFailure {
  code: 'MCP_INVALID_ARGUMENTS';
  message: string;
  field?: string;
}

export type McpSchemaValidationOutcome =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: McpSchemaValidationFailure };

type NormalizeOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: McpSchemaValidationFailure };

function getCompiledPattern(pattern: string): RegExp | null {
  const cached = PATTERN_REGEX_CACHE.get(pattern);
  if (cached) {
    return cached;
  }
  try {
    const compiled = new RegExp(pattern);
    if (PATTERN_REGEX_CACHE.size >= MAX_PATTERN_CACHE_ENTRIES) {
      const firstKey = PATTERN_REGEX_CACHE.keys().next();
      if (!firstKey.done) {
        PATTERN_REGEX_CACHE.delete(firstKey.value);
      }
    }
    PATTERN_REGEX_CACHE.set(pattern, compiled);
    return compiled;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasForbiddenOwnProperty(obj: Record<string, unknown>): string | null {
  for (const key of FORBIDDEN_OWN_PROPERTIES) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return key;
    }
  }
  return null;
}

function matchesSingleType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value) && hasForbiddenOwnProperty(value) === null;
    default:
      return true;
  }
}

function normalizeNfcDeep(
  toolName: string,
  value: unknown,
  path = '',
  depth = 0,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): NormalizeOutcome {
  const fieldLabel = path || 'arguments';
  if (depth > MAX_SCHEMA_DEPTH) {
    return {
      ok: false,
      error: {
        code: 'MCP_INVALID_ARGUMENTS',
        message: `Argument '${fieldLabel}' in tool '${toolName}' exceeds maximum nesting depth (${MAX_SCHEMA_DEPTH}).`,
        field: fieldLabel,
      },
    };
  }

  if (typeof value === 'string') {
    return { ok: true, value: value.normalize('NFC') };
  }

  if (typeof value === 'object' && value !== null) {
    if (ancestors.has(value)) {
      return {
        ok: false,
        error: {
          code: 'MCP_INVALID_ARGUMENTS',
          message: `Circular reference detected in '${fieldLabel}' for tool '${toolName}'.`,
          field: fieldLabel,
        },
      };
    }

    if (Array.isArray(value)) {
      ancestors.add(value);
      try {
        const out: unknown[] = [];
        for (let idx = 0; idx < value.length; idx += 1) {
          const itemPath = path ? `${path}[${idx}]` : `[${idx}]`;
          const itemResult = normalizeNfcDeep(
            toolName,
            value[idx],
            itemPath,
            depth + 1,
            ancestors,
          );
          if (!itemResult.ok) {
            return itemResult;
          }
          out.push(itemResult.value);
        }
        return { ok: true, value: out };
      } finally {
        ancestors.delete(value);
      }
    }

    if (isPlainObject(value)) {
      const forbidden = hasForbiddenOwnProperty(value);
      if (forbidden) {
        return {
          ok: false,
          error: {
            code: 'MCP_INVALID_ARGUMENTS',
            message: `Forbidden property '${forbidden}' in arguments for tool '${toolName}'.`,
            field: path ? `${path}.${forbidden}` : forbidden,
          },
        };
      }
      ancestors.add(value);
      try {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value)) {
          if (FORBIDDEN_OWN_PROPERTY_SET.has(key)) continue;
          const childPath = path ? `${path}.${key}` : key;
          const childResult = normalizeNfcDeep(
            toolName,
            value[key],
            childPath,
            depth + 1,
            ancestors,
          );
          if (!childResult.ok) {
            return childResult;
          }
          out[key] = childResult.value;
        }
        return { ok: true, value: out };
      } finally {
        ancestors.delete(value);
      }
    }
  }

  return { ok: true, value };
}

function validateNode(
  toolName: string,
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  depth = 0,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): McpSchemaValidationFailure | null {
  const fieldLabel = path || 'arguments';

  if (depth > MAX_SCHEMA_DEPTH) {
    return {
      code: 'MCP_INVALID_ARGUMENTS',
      message: `Argument '${fieldLabel}' in tool '${toolName}' exceeds maximum nesting depth (${MAX_SCHEMA_DEPTH}).`,
      field: fieldLabel,
    };
  }

  if (typeof value === 'object' && value !== null && ancestors.has(value)) {
    return {
      code: 'MCP_INVALID_ARGUMENTS',
      message: `Circular reference detected in '${fieldLabel}' for tool '${toolName}'.`,
      field: fieldLabel,
    };
  }

  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.filter((b): b is Record<string, unknown> =>
      isPlainObject(b),
    );
    const matched = branches.some(
      (branch) =>
        validateNode(toolName, branch, value, path, depth, ancestors) === null,
    );
    if (!matched) {
      return {
        code: 'MCP_INVALID_ARGUMENTS',
        message: `Invalid value for '${fieldLabel}' in tool '${toolName}'.`,
        field: fieldLabel,
      };
    }
    return null;
  }

  const rawType = schema.type;
  if (typeof rawType === 'string') {
    if (!matchesSingleType(value, rawType)) {
      return {
        code: 'MCP_INVALID_ARGUMENTS',
        message: `Invalid type for '${fieldLabel}' in tool '${toolName}': expected ${rawType}.`,
        field: fieldLabel,
      };
    }
  } else if (Array.isArray(rawType)) {
    const allowedTypes = rawType.filter(
      (t): t is string => typeof t === 'string',
    );
    if (
      allowedTypes.length > 0 &&
      !allowedTypes.some((t) => matchesSingleType(value, t))
    ) {
      return {
        code: 'MCP_INVALID_ARGUMENTS',
        message: `Invalid type for '${fieldLabel}' in tool '${toolName}': expected ${allowedTypes.join(' | ')}.`,
        field: fieldLabel,
      };
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return {
      code: 'MCP_INVALID_ARGUMENTS',
      message: `Invalid value for '${fieldLabel}' in tool '${toolName}': must be one of ${schema.enum.map(String).join(', ')}.`,
      field: fieldLabel,
    };
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return {
        code: 'MCP_INVALID_ARGUMENTS',
        message: `Argument '${fieldLabel}' in tool '${toolName}' must be >= ${schema.minimum}.`,
        field: fieldLabel,
      };
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return {
        code: 'MCP_INVALID_ARGUMENTS',
        message: `Argument '${fieldLabel}' in tool '${toolName}' must be <= ${schema.maximum}.`,
        field: fieldLabel,
      };
    }
  }

  if (typeof value === 'string') {
    const normalized = value.normalize('NFC');
    if (
      typeof schema.minLength === 'number' &&
      normalized.length < schema.minLength
    ) {
      return {
        code: 'MCP_INVALID_ARGUMENTS',
        message: `Argument '${fieldLabel}' in tool '${toolName}' must be at least ${schema.minLength} character(s).`,
        field: fieldLabel,
      };
    }
    if (
      typeof schema.maxLength === 'number' &&
      normalized.length > schema.maxLength
    ) {
      return {
        code: 'MCP_INVALID_ARGUMENTS',
        message: `Argument '${fieldLabel}' in tool '${toolName}' must be at most ${schema.maxLength} characters.`,
        field: fieldLabel,
      };
    }
    if (typeof schema.pattern === 'string') {
      const regex = getCompiledPattern(schema.pattern);
      if (!regex || !regex.test(normalized)) {
        return {
          code: 'MCP_INVALID_ARGUMENTS',
          message: `Argument '${fieldLabel}' in tool '${toolName}' has an invalid format.`,
          field: fieldLabel,
        };
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      return {
        code: 'MCP_INVALID_ARGUMENTS',
        message: `Argument '${fieldLabel}' in tool '${toolName}' must contain at least ${schema.minItems} item(s).`,
        field: fieldLabel,
      };
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      return {
        code: 'MCP_INVALID_ARGUMENTS',
        message: `Argument '${fieldLabel}' in tool '${toolName}' must contain at most ${schema.maxItems} items.`,
        field: fieldLabel,
      };
    }
    const itemSchema = isPlainObject(schema.items) ? schema.items : {};
    ancestors.add(value);
    try {
      for (let idx = 0; idx < value.length; idx += 1) {
        const itemPath = path ? `${path}[${idx}]` : `[${idx}]`;
        const itemErr = validateNode(
          toolName,
          itemSchema,
          value[idx],
          itemPath,
          depth + 1,
          ancestors,
        );
        if (itemErr) return itemErr;
      }
    } finally {
      ancestors.delete(value);
    }
  }

  if (isPlainObject(value)) {
    const forbidden = hasForbiddenOwnProperty(value);
    if (forbidden) {
      return {
        code: 'MCP_INVALID_ARGUMENTS',
        message: `Forbidden property '${forbidden}' in arguments for tool '${toolName}'.`,
        field: path ? `${path}.${forbidden}` : forbidden,
      };
    }

    const properties = isPlainObject(schema.properties)
      ? schema.properties
      : {};
    const allowedKeys = Object.keys(properties);
    const allowedSet = new Set(allowedKeys);

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!allowedSet.has(key)) {
          const allowedList =
            allowedKeys.length > 0 ? allowedKeys.join(', ') : 'none';
          const targetKey = path ? `${path}.${key}` : key;
          return {
            code: 'MCP_INVALID_ARGUMENTS',
            message: path
              ? `Unknown argument '${targetKey}' for tool '${toolName}'. Allowed properties: ${allowedList}.`
              : `Unknown argument '${key}' for tool '${toolName}'. Allowed arguments: ${allowedList}.`,
            field: targetKey,
          };
        }
      }
    }

    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (
          typeof reqKey === 'string' &&
          (!Object.prototype.hasOwnProperty.call(value, reqKey) ||
            value[reqKey] === undefined)
        ) {
          const missingField = path ? `${path}.${reqKey}` : reqKey;
          return {
            code: 'MCP_INVALID_ARGUMENTS',
            message: `Missing required argument '${missingField}' for tool '${toolName}'.`,
            field: missingField,
          };
        }
      }
    }

    ancestors.add(value);
    try {
      for (const [propKey, propSchema] of Object.entries(properties)) {
        if (!isPlainObject(propSchema)) continue;
        const propVal = value[propKey];
        if (propVal === undefined) continue;
        const childPath = path ? `${path}.${propKey}` : propKey;
        const propErr = validateNode(
          toolName,
          propSchema,
          propVal,
          childPath,
          depth + 1,
          ancestors,
        );
        if (propErr) return propErr;
      }

      if (schema.additionalProperties !== false) {
        for (const key of Object.keys(value)) {
          if (allowedSet.has(key)) continue;
          const extraVal = value[key];
          if (extraVal === undefined) continue;
          const childPath = path ? `${path}.${key}` : key;
          const extraErr = validateNode(
            toolName,
            {},
            extraVal,
            childPath,
            depth + 1,
            ancestors,
          );
          if (extraErr) return extraErr;
        }
      }
    } finally {
      ancestors.delete(value);
    }
  }

  return null;
}

export function validateMcpToolArguments(
  toolName: string,
  rootSchema: Record<string, unknown>,
  rawArgs: unknown,
): McpSchemaValidationOutcome {
  const effectiveArgs = rawArgs === undefined ? {} : rawArgs;
  if (!isPlainObject(effectiveArgs)) {
    return {
      ok: false,
      error: {
        code: 'MCP_INVALID_ARGUMENTS',
        message: `Arguments for tool '${toolName}' must be a plain JSON object.`,
      },
    };
  }

  const forbidden = hasForbiddenOwnProperty(effectiveArgs);
  if (forbidden) {
    const properties = isPlainObject(rootSchema.properties)
      ? Object.keys(rootSchema.properties)
      : [];
    const allowedList = properties.length > 0 ? properties.join(', ') : 'none';
    return {
      ok: false,
      error: {
        code: 'MCP_INVALID_ARGUMENTS',
        message: `Unknown argument '${forbidden}' for tool '${toolName}'. Allowed arguments: ${allowedList}.`,
        field: forbidden,
      },
    };
  }

  const failure = validateNode(
    toolName,
    rootSchema,
    effectiveArgs,
    '',
    0,
    new WeakSet<object>(),
  );
  if (failure) {
    return { ok: false, error: failure };
  }

  const normalized = normalizeNfcDeep(
    toolName,
    effectiveArgs,
    '',
    0,
    new WeakSet<object>(),
  );
  if (!normalized.ok) {
    return { ok: false, error: normalized.error };
  }

  return {
    ok: true,
    args: normalized.value as Record<string, unknown>,
  };
}
