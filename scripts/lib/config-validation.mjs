import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const supportedTypes = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);

function typeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function joinPointer(pointer, key) {
  const escaped = String(key).replaceAll('~', '~0').replaceAll('/', '~1');
  return `${pointer}/${escaped}`;
}

async function assertInside(root, candidate) {
  const [resolvedRoot, resolvedCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Configuration path escapes the approved workspace.');
  }
  return resolvedCandidate;
}

async function readJson(filePath, root) {
  const safePath = await assertInside(root, filePath);
  const text = await readFile(safePath, 'utf8');
  try {
    return { value: JSON.parse(text), filePath: safePath };
  } catch {
    throw new Error(`Invalid JSON: ${path.relative(root, safePath)}`);
  }
}

async function validateNode(value, schema, context, pointer = '') {
  const errors = [];

  if (schema.$ref) {
    if (schema.$ref.includes('#') || path.isAbsolute(schema.$ref)) {
      return [`${pointer || '/'}: unsupported schema reference`];
    }
    const referencedPath = path.resolve(path.dirname(context.schemaPath), schema.$ref);
    const referenced = await readJson(referencedPath, context.root);
    return validateNode(value, referenced.value, { ...context, schemaPath: referenced.filePath }, pointer);
  }

  if (schema.type) {
    if (!supportedTypes.has(schema.type)) {
      return [`${pointer || '/'}: schema uses unsupported type`];
    }
    if (!typeMatches(value, schema.type)) {
      return [`${pointer || '/'}: expected ${schema.type}`];
    }
  }

  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) {
    errors.push(`${pointer || '/'}: value does not match the required constant`);
  }

  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${pointer || '/'}: value is not in the allowed set`);
  }

  if (typeof value === 'string' && schema.pattern && !(new RegExp(schema.pattern)).test(value)) {
    errors.push(`${pointer || '/'}: value does not match the required format`);
  }

  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      errors.push(...await validateNode(value[index], schema.items, context, joinPointer(pointer, index)));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        errors.push(`${joinPointer(pointer, required)}: required property is missing`);
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        errors.push(...await validateNode(item, properties[key], context, joinPointer(pointer, key)));
      } else if (schema.additionalProperties === false) {
        errors.push(`${joinPointer(pointer, key)}: additional property is not allowed`);
      }
    }
  }

  return errors;
}

export async function validateConfig(root, configRelative = 'config/foundation.json') {
  const configPath = path.resolve(root, configRelative);
  const config = await readJson(configPath, root);
  const schemaRef = config.value.$schema;
  if (typeof schemaRef !== 'string' || schemaRef.length === 0) {
    return { ok: false, errors: ['/$schema: required property is missing'] };
  }

  const schemaPath = path.resolve(path.dirname(config.filePath), schemaRef);
  const schema = await readJson(schemaPath, root);
  const errors = await validateNode(config.value, schema.value, {
    root,
    schemaPath: schema.filePath
  });

  return { ok: errors.length === 0, errors };
}

export async function validateValueAgainstSchema(root, schemaRelative, value) {
  const schema = await readJson(path.resolve(root, schemaRelative), root);
  const errors = await validateNode(value, schema.value, { root, schemaPath: schema.filePath });
  return { ok: errors.length === 0, errors };
}

