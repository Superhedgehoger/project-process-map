import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ArtifactKind,
  ArtifactValidationError,
  ArtifactDigestMismatchError,
} from "./types.ts";

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

const schemaCache = new Map<string, Record<string, unknown>>();

/**
 * Whitelist of allowed keywords in Cindy Control Schema Dialect v1.
 * Any keyword not in this set triggers immediate schema rejection (fail-closed).
 */
export const ALLOWED_DIALECT_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minItems",
]);

const ALLOWED_PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "null",
  "array",
  "object",
]);

/**
 * Recursively validates that a schema conforms strictly to Cindy Control Schema Dialect v1.
 * Fails closed on any unknown/unsupported keyword or incorrect keyword argument type.
 */
export function assertValidSchemaDialect(schema: unknown, path = "$"): void {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    throw new ArtifactValidationError(
      `Schema dialect error at ${path}: schema must be a non-null object`
    );
  }

  const record = schema as Record<string, unknown>;

  // Check for unknown keywords
  for (const key of Object.keys(record)) {
    if (!ALLOWED_DIALECT_KEYWORDS.has(key)) {
      throw new ArtifactValidationError(
        `Schema dialect error: unsupported or unknown keyword '${key}' at path '${path}'`
      );
    }
  }

  // Meta-validate keyword parameter types
  if (record.$schema !== undefined && typeof record.$schema !== "string") {
    throw new ArtifactValidationError(`Schema dialect error at ${path}.$schema: must be a string`);
  }

  if (record.$id !== undefined && typeof record.$id !== "string") {
    throw new ArtifactValidationError(`Schema dialect error at ${path}.$id: must be a string`);
  }

  if (record.title !== undefined && typeof record.title !== "string") {
    throw new ArtifactValidationError(`Schema dialect error at ${path}.title: must be a string`);
  }

  if (record.description !== undefined && typeof record.description !== "string") {
    throw new ArtifactValidationError(`Schema dialect error at ${path}.description: must be a string`);
  }

  if (record.type !== undefined) {
    if (typeof record.type === "string") {
      if (!ALLOWED_PRIMITIVE_TYPES.has(record.type)) {
        throw new ArtifactValidationError(
          `Schema dialect error at ${path}.type: unknown primitive type '${record.type}'`
        );
      }
    } else if (Array.isArray(record.type)) {
      for (const t of record.type) {
        if (typeof t !== "string" || !ALLOWED_PRIMITIVE_TYPES.has(t)) {
          throw new ArtifactValidationError(
            `Schema dialect error at ${path}.type: unknown primitive type in array: ${String(t)}`
          );
        }
      }
    } else {
      throw new ArtifactValidationError(
        `Schema dialect error at ${path}.type: must be a string or array of strings`
      );
    }
  }

  if (record.properties !== undefined) {
    if (record.properties === null || typeof record.properties !== "object" || Array.isArray(record.properties)) {
      throw new ArtifactValidationError(
        `Schema dialect error at ${path}.properties: must be a non-null object`
      );
    }
    for (const [propName, propSchema] of Object.entries(record.properties as Record<string, unknown>)) {
      assertValidSchemaDialect(propSchema, `${path}.properties.${propName}`);
    }
  }

  if (record.required !== undefined) {
    if (!Array.isArray(record.required) || record.required.some((k) => typeof k !== "string")) {
      throw new ArtifactValidationError(
        `Schema dialect error at ${path}.required: must be an array of strings`
      );
    }
  }

  if (record.additionalProperties !== undefined) {
    if (typeof record.additionalProperties !== "boolean" && (record.additionalProperties === null || typeof record.additionalProperties !== "object" || Array.isArray(record.additionalProperties))) {
      throw new ArtifactValidationError(
        `Schema dialect error at ${path}.additionalProperties: must be a boolean or schema object`
      );
    }
    if (typeof record.additionalProperties === "object" && record.additionalProperties !== null) {
      assertValidSchemaDialect(record.additionalProperties, `${path}.additionalProperties`);
    }
  }

  if (record.items !== undefined) {
    // Boolean schema items (items: true/false) are NOT supported in Cindy Control Schema Dialect v1.
    // Fail closed if items is a boolean value.
    if (typeof record.items === "boolean") {
      throw new ArtifactValidationError(
        `Schema dialect error at ${path}.items: boolean schema for items is not supported in Cindy Control Schema Dialect v1; ` +
        `use an explicit schema object instead`
      );
    }
    if (record.items === null || typeof record.items !== "object" || Array.isArray(record.items)) {
      throw new ArtifactValidationError(
        `Schema dialect error at ${path}.items: must be a schema object`
      );
    }
    assertValidSchemaDialect(record.items, `${path}.items`);
  }

  if (record.enum !== undefined) {
    if (!Array.isArray(record.enum)) {
      throw new ArtifactValidationError(`Schema dialect error at ${path}.enum: must be an array`);
    }
  }

  if (record.minimum !== undefined) {
    if (typeof record.minimum !== "number" || Number.isNaN(record.minimum)) {
      throw new ArtifactValidationError(`Schema dialect error at ${path}.minimum: must be a number`);
    }
  }

  if (record.maximum !== undefined) {
    if (typeof record.maximum !== "number" || Number.isNaN(record.maximum)) {
      throw new ArtifactValidationError(`Schema dialect error at ${path}.maximum: must be a number`);
    }
  }

  if (record.pattern !== undefined) {
    if (typeof record.pattern !== "string") {
      throw new ArtifactValidationError(`Schema dialect error at ${path}.pattern: must be a regex string`);
    }
    try {
      new RegExp(record.pattern);
    } catch (err: unknown) {
      throw new ArtifactValidationError(
        `Schema dialect error at ${path}.pattern: invalid regular expression: ${String(err)}`
      );
    }
  }

  if (record.format !== undefined) {
    if (typeof record.format !== "string") {
      throw new ArtifactValidationError(`Schema dialect error at ${path}.format: must be a string`);
    }
    // Cindy Control Schema Dialect v1 only supports 'date-time' format.
    // Any other format value is rejected (fail closed — unknown format).
    if (record.format !== "date-time") {
      throw new ArtifactValidationError(
        `Schema dialect error at ${path}.format: unsupported format '${record.format}'; ` +
        `Cindy Control Schema Dialect v1 only supports format 'date-time'`
      );
    }
  }

  if (record.minLength !== undefined) {
    if (typeof record.minLength !== "number" || !Number.isInteger(record.minLength) || record.minLength < 0) {
      throw new ArtifactValidationError(
        `Schema dialect error at ${path}.minLength: must be a non-negative integer`
      );
    }
  }

  if (record.maxLength !== undefined) {
    if (typeof record.maxLength !== "number" || !Number.isInteger(record.maxLength) || record.maxLength < 0) {
      throw new ArtifactValidationError(
        `Schema dialect error at ${path}.maxLength: must be a non-negative integer`
      );
    }
  }

  if (record.minItems !== undefined) {
    if (typeof record.minItems !== "number" || !Number.isInteger(record.minItems) || record.minItems < 0) {
      throw new ArtifactValidationError(
        `Schema dialect error at ${path}.minItems: must be a non-negative integer`
      );
    }
  }
}

/**
 * Cindy Control Schema Dialect v1 identifier.
 * All Cindy artifact schemas must declare this $schema identifier.
 * Schemas declaring any other $schema identifier are rejected (fail closed).
 */
export const CINDY_DIALECT_SCHEMA_ID = "https://cindy.control-plane.local/schemas/dialect/v1";

/**
 * Load, meta-validate, and cache JSON Schema definition from disk.
 * Enforces that the schema declares the Cindy Control Schema Dialect v1 identifier.
 */
export function loadArtifactSchema(repoDir: string, schemaFileName: string): Record<string, unknown> {
  const schemaPath = resolve(repoDir, "schemas", schemaFileName);
  if (schemaCache.has(schemaPath)) {
    return schemaCache.get(schemaPath)!;
  }

  let finalPath = schemaPath;
  if (!existsSync(finalPath)) {
    const cwdSchemaPath = resolve(process.cwd(), "schemas", schemaFileName);
    if (existsSync(cwdSchemaPath)) {
      finalPath = cwdSchemaPath;
    } else {
      throw new ArtifactValidationError(`JSON schema not found: ${schemaPath}`);
    }
  }

  try {
    const raw = readFileSync(finalPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Enforce dialect identifier: schema must declare the Cindy Control Schema Dialect v1 $schema.
    // This prevents accidentally loading standard JSON Schema Draft 2020-12 schemas
    // or any other schema system. Fail closed if $schema is missing or wrong.
    if (parsed.$schema !== CINDY_DIALECT_SCHEMA_ID) {
      throw new ArtifactValidationError(
        `Schema '${schemaFileName}' declares $schema '${String(parsed.$schema)}' but must use ` +
        `Cindy Control Schema Dialect v1 identifier: '${CINDY_DIALECT_SCHEMA_ID}'`
      );
    }

    assertValidSchemaDialect(parsed);
    schemaCache.set(schemaPath, parsed);
    return parsed;
  } catch (err: unknown) {
    if (err instanceof ArtifactValidationError) {
      throw err;
    }
    throw new ArtifactValidationError(
      `Failed to load JSON schema ${finalPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Maps artifact kind to corresponding schema file name.
 * Every valid ArtifactKind has a registered schema.
 */
export function getSchemaFileForKind(kind: string): string {
  switch (kind) {
    case ArtifactKind.RUN:
      return "cindy-run.schema.json";
    case ArtifactKind.BASELINE:
      return "cindy-baseline.schema.json";
    case ArtifactKind.DIFF_MANIFEST:
      return "cindy-diff-manifest.schema.json";
    case ArtifactKind.TEST_RESULT:
      return "cindy-test-result.schema.json";
    case ArtifactKind.REVIEW_REQUEST:
      return "cindy-review-request.schema.json";
    case ArtifactKind.REVIEW_RESULT:
      return "cindy-review.schema.json";
    case ArtifactKind.REPAIR_INIT:
      return "cindy-repair-init.schema.json";
    case ArtifactKind.CLOSEOUT:
      return "cindy-closeout.schema.json";
    case ArtifactKind.GIT_RECEIPT:
      return "cindy-git-receipt.schema.json";
    case ArtifactKind.NEXT_TASK:
      return "cindy-next-task.schema.json";
    case ArtifactKind.TASK_PACKET:
      return "cindy-task-packet.schema.json";
    case ArtifactKind.EXECUTION_INPUTS:
      return "cindy-execution-inputs.schema.json";
    default:
      throw new ArtifactValidationError(`No schema registered for artifact kind '${kind}'`);
  }
}

const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/i;

/**
 * Validates payload against Cindy Control Schema Dialect v1.
 * Enforces meta-validation before payload validation.
 */
export function validateDraft2020(data: unknown, schema: Record<string, unknown>, path = "$"): string[] {
  // First assert that the schema itself satisfies Dialect v1
  assertValidSchemaDialect(schema, path);

  const errors: string[] = [];

  // 1. type
  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const isMatchingType = allowedTypes.some((t) => {
      switch (t) {
        case "string":
          return typeof data === "string";
        case "number":
          return typeof data === "number" && !Number.isNaN(data);
        case "integer":
          return typeof data === "number" && Number.isInteger(data);
        case "boolean":
          return typeof data === "boolean";
        case "null":
          return data === null;
        case "array":
          return Array.isArray(data);
        case "object":
          return data !== null && typeof data === "object" && !Array.isArray(data);
        default:
          return false;
      }
    });

    if (!isMatchingType) {
      errors.push(
        `${path}: expected type ${JSON.stringify(schema.type)}, got ${
          Array.isArray(data) ? "array" : data === null ? "null" : typeof data
        }`
      );
      return errors;
    }
  }

  // 2. enum
  if (Array.isArray(schema.enum)) {
    const matches = schema.enum.some((val) => val === data);
    if (!matches) {
      errors.push(`${path}: value ${JSON.stringify(data)} not in enum ${JSON.stringify(schema.enum)}`);
    }
  }

  // 3. const
  if (schema.const !== undefined) {
    if (data !== schema.const) {
      errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(data)}`);
    }
  }

  // 4. minimum
  if (typeof schema.minimum === "number" && typeof data === "number") {
    if (data < schema.minimum) {
      errors.push(`${path}: ${data} is less than minimum ${schema.minimum}`);
    }
  }

  // 5. maximum
  if (typeof schema.maximum === "number" && typeof data === "number") {
    if (data > schema.maximum) {
      errors.push(`${path}: ${data} is greater than maximum ${schema.maximum}`);
    }
  }

  // 6. pattern
  if (typeof schema.pattern === "string" && typeof data === "string") {
    const re = new RegExp(schema.pattern);
    if (!re.test(data)) {
      errors.push(`${path}: string does not match pattern ${schema.pattern}`);
    }
  }

  // 7. format
  if (schema.format === "date-time" && typeof data === "string") {
    if (!ISO_DATETIME_REGEX.test(data) || Number.isNaN(Date.parse(data))) {
      errors.push(`${path}: invalid date-time format: ${data}`);
    }
  }

  // 8. minLength
  if (typeof schema.minLength === "number" && typeof data === "string") {
    if (data.length < schema.minLength) {
      errors.push(`${path}: string length ${data.length} is less than minLength ${schema.minLength}`);
    }
  }

  // 9. maxLength
  if (typeof schema.maxLength === "number" && typeof data === "string") {
    if (data.length > schema.maxLength) {
      errors.push(`${path}: string length ${data.length} is greater than maxLength ${schema.maxLength}`);
    }
  }

  // 10. minItems
  if (typeof schema.minItems === "number" && Array.isArray(data)) {
    if (data.length < schema.minItems) {
      errors.push(`${path}: array length ${data.length} is less than minItems ${schema.minItems}`);
    }
  }

  // Object checks
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;

    // required
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required as string[]) {
        if (!Object.prototype.hasOwnProperty.call(obj, reqKey) || obj[reqKey] === undefined) {
          errors.push(`${path}: missing required property '${reqKey}'`);
        }
      }
    }

    const properties = (schema.properties as Record<string, Record<string, unknown>>) ?? {};

    // properties validation
    for (const [propKey, propSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(obj, propKey) && obj[propKey] !== undefined) {
        const subErrors = validateDraft2020(obj[propKey], propSchema, `${path}.${propKey}`);
        errors.push(...subErrors);
      }
    }

    // additionalProperties: false
    if (schema.additionalProperties === false) {
      for (const actualKey of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(properties, actualKey)) {
          errors.push(`${path}: unexpected additional property '${actualKey}'`);
        }
      }
    } else if (typeof schema.additionalProperties === "object" && schema.additionalProperties !== null) {
      const addSchema = schema.additionalProperties as Record<string, unknown>;
      for (const actualKey of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(properties, actualKey)) {
          const subErrors = validateDraft2020(obj[actualKey], addSchema, `${path}.${actualKey}`);
          errors.push(...subErrors);
        }
      }
    }
  }

  // Array checks
  if (Array.isArray(data) && schema.items && typeof schema.items === "object") {
    const itemSchema = schema.items as Record<string, unknown>;
    data.forEach((item, index) => {
      const itemErrors = validateDraft2020(item, itemSchema, `${path}[${index}]`);
      errors.push(...itemErrors);
    });
  }

  return errors;
}

export interface SemanticValidationContext {
  runId: string;
  taskId?: string | undefined;
  cycle?: number | undefined;
  expectedTreeDigest?: string | undefined;
  expectedBaseCommit?: string | undefined;
}

/**
 * Perform cross-field, identity, binding, execution result consistency, and format semantic validation
 * beyond structural JSON schema.
 */
export function validateArtifactSemantics(
  kind: string,
  data: unknown,
  context: SemanticValidationContext
): void {
  if (data === null || typeof data !== "object") {
    throw new ArtifactValidationError(`Artifact payload must be a non-null object`);
  }

  const record = data as Record<string, unknown>;

  // 1. runId binding
  if (typeof record.runId === "string" && record.runId !== context.runId) {
    throw new ArtifactValidationError(
      `Artifact runId mismatch: payload has '${record.runId}' but expected '${context.runId}'`
    );
  }

  // 2. taskId binding
  if (context.taskId && typeof record.taskId === "string" && record.taskId !== context.taskId) {
    throw new ArtifactValidationError(
      `Artifact taskId mismatch: payload has '${record.taskId}' but expected '${context.taskId}'`
    );
  }

  // 3. cycle binding
  if (context.cycle !== undefined) {
    if (typeof record.cycle === "number" && record.cycle !== context.cycle) {
      throw new ArtifactValidationError(
        `Artifact cycle mismatch: payload has cycle ${record.cycle} but expected cycle ${context.cycle}`
      );
    }
  }

  // 4. Execution result consistency: status === PASS requires exitCode === 0
  if (kind === ArtifactKind.TEST_RESULT) {
    const status = record.status as string | undefined;
    const exitCode = record.exitCode as number | undefined;
    if (status === "PASS" && exitCode !== 0) {
      throw new ArtifactValidationError(
        `Test result inconsistency: status is 'PASS' but exitCode is ${String(exitCode)}; must be 0 for PASS`
      );
    }
  }

  // 5. Reviewer read-only confirmation and session
  if (kind === ArtifactKind.REVIEW_REQUEST || kind === ArtifactKind.REVIEW_RESULT) {
    const reviewer = record.reviewer as {
      identity?: string;
      session?: string;
      readOnlyConfirmed?: boolean;
      readOnlyRequired?: boolean;
    } | undefined;
    if (!reviewer || typeof reviewer !== "object") {
      throw new ArtifactValidationError(
        `Artifact kind '${kind}' requires reviewer object`
      );
    }
    if (!reviewer.session || typeof reviewer.session !== "string" || reviewer.session.trim().length === 0) {
      throw new ArtifactValidationError(
        `Artifact kind '${kind}' requires non-empty reviewer.session`
      );
    }
    if (kind === ArtifactKind.REVIEW_RESULT && reviewer.readOnlyConfirmed !== true) {
      throw new ArtifactValidationError(
        `Artifact kind '${kind}' requires reviewer.readOnlyConfirmed === true`
      );
    }
    if (kind === ArtifactKind.REVIEW_REQUEST) {
      if (reviewer.readOnlyConfirmed === false || reviewer.readOnlyRequired === false) {
        throw new ArtifactValidationError(
          `Artifact kind '${kind}' readOnly mode cannot be false`
        );
      }
      if (reviewer.readOnlyConfirmed !== true && reviewer.readOnlyRequired !== true) {
        throw new ArtifactValidationError(
          `Artifact kind '${kind}' requires reviewer readOnly mode confirmed/required === true`
        );
      }
    }
  }

  // 6. tree digest format and matching
  const treeDigest = (record.boundTreeDigest ??
    record.reviewedTreeDigest ??
    record.finalTreeDigest ??
    record.treeDigest) as string | undefined;

  if (treeDigest) {
    if (!SHA256_HEX_REGEX.test(treeDigest) && !treeDigest.startsWith("TREE:CLEAN:")) {
      throw new ArtifactValidationError(
        `Artifact specifies invalid tree digest format: '${treeDigest}' (must be 64-char hex SHA256)`
      );
    }

    if (context.expectedTreeDigest && treeDigest !== context.expectedTreeDigest) {
      throw new ArtifactDigestMismatchError(
        `Artifact tree digest '${treeDigest}' does not match expected working tree digest '${context.expectedTreeDigest}'`
      );
    }
  }

  // 7. diff digest format
  const diffDigest = (record.diffDigest ?? record.reviewedDiffDigest) as string | undefined;
  if (diffDigest && !SHA256_HEX_REGEX.test(diffDigest)) {
    throw new ArtifactValidationError(
      `Artifact specifies invalid diff digest format: '${diffDigest}' (must be 64-char hex SHA256)`
    );
  }

  // 8. base commit matching
  const baseCommit = (record.baseCommit ?? record.reviewedBaseCommit) as string | undefined;
  if (context.expectedBaseCommit && baseCommit && baseCommit !== context.expectedBaseCommit) {
    throw new ArtifactValidationError(
      `Artifact base commit mismatch: payload has '${baseCommit}' but expected '${context.expectedBaseCommit}'`
    );
  }

  // 9. Upstream snapshot completeness for RUN and BASELINE
  if (kind === ArtifactKind.RUN || kind === ArtifactKind.BASELINE) {
    if (typeof record.upstreamRef !== "string" || record.upstreamRef.trim().length === 0) {
      throw new ArtifactValidationError(
        `Artifact kind '${kind}' requires non-empty upstreamRef string`
      );
    }
    if (
      typeof record.upstreamCommit !== "string" ||
      !/^[0-9a-f]{40}$/.test(record.upstreamCommit)
    ) {
      throw new ArtifactValidationError(
        `Artifact kind '${kind}' requires valid 40-character hex upstreamCommit string`
      );
    }
  }
}

/**
 * Validates an artifact at the write or read boundary.
 * Runs JSON Schema validation and semantic cross-field checks.
 * Fails closed on any error.
 */
export function validateArtifactBoundary(
  repoDir: string,
  kind: string,
  data: unknown,
  context: SemanticValidationContext
): void {
  const schemaFile = getSchemaFileForKind(kind);
  const schema = loadArtifactSchema(repoDir, schemaFile);
  const errors = validateDraft2020(data, schema);
  if (errors.length > 0) {
    throw new ArtifactValidationError(
      `Schema validation failed for artifact '${kind}': ${errors.join("; ")}`
    );
  }

  validateArtifactSemantics(kind, data, context);
}
