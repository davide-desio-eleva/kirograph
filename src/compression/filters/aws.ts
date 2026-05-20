/**
 * AWS CLI output filters
 *
 * Compresses verbose AWS CLI JSON output into compact, actionable summaries.
 * Strips policy documents, type annotations (DynamoDB), progress bars, and boilerplate.
 */

import type { CommandFilter, FilterResult, CompressorOptions } from '../types';

export const awsFilter: CommandFilter = {
  name: 'aws',

  matches(command: string): boolean {
    return /\baws\s/.test(command);
  },

  filter(command: string, rawOutput: string, level: CompressorOptions['level']): FilterResult {
    const subcommand = extractAwsSubcommand(command);

    switch (subcommand) {
      case 'sts:get-caller-identity': return filterStsIdentity(rawOutput, level);
      case 'ec2:describe-instances': return filterEc2Instances(rawOutput, level);
      case 'lambda:list-functions': return filterLambdaFunctions(rawOutput, level);
      case 'logs:get-log-events': return filterLogEvents(rawOutput, level);
      case 'cloudformation:describe-stack-events': return filterCfnEvents(rawOutput, level);
      case 'dynamodb:scan':
      case 'dynamodb:query':
      case 'dynamodb:get-item': return filterDynamoDB(rawOutput, level);
      case 'iam:list-roles': return filterIamRoles(rawOutput, level);
      case 'iam:list-policies': return filterIamPolicies(rawOutput, level);
      case 's3:ls': return filterS3Ls(rawOutput, level);
      case 's3:cp':
      case 's3:sync': return filterS3Transfer(rawOutput, level);
      case 'ecs:list-tasks':
      case 'ecs:describe-tasks': return filterEcsTasks(rawOutput, level);
      case 'ecs:describe-services': return filterEcsServices(rawOutput, level);
      case 'sqs:list-queues': return filterSqsQueues(rawOutput, level);
      case 'sns:list-topics': return filterSnsTopics(rawOutput, level);
      default: return filterGenericAws(rawOutput, level);
    }
  },
};

function extractAwsSubcommand(command: string): string {
  // "aws sts get-caller-identity" → "sts:get-caller-identity"
  const match = command.match(/aws\s+(\S+)\s+(\S+)/);
  if (match) return `${match[1]}:${match[2]}`;
  const serviceOnly = command.match(/aws\s+(\S+)/);
  if (serviceOnly) return serviceOnly[1];
  return '';
}

// ── STS ───────────────────────────────────────────────────────────────────────

function filterStsIdentity(raw: string, level: CompressorOptions['level']): FilterResult {
  try {
    const data = JSON.parse(raw);
    if (level === 'ultra') {
      return { output: `${data.Account} ${data.Arn?.split('/').pop() || ''}`, strategy: 'aws:sts:ultra' };
    }
    return { output: `Account: ${data.Account}\nArn: ${data.Arn}\nUserId: ${data.UserId}`, strategy: 'aws:sts' };
  } catch {
    return { output: raw, strategy: 'aws:sts:passthrough' };
  }
}

// ── EC2 ───────────────────────────────────────────────────────────────────────

function filterEc2Instances(raw: string, level: CompressorOptions['level']): FilterResult {
  try {
    const data = JSON.parse(raw);
    const instances: string[] = [];

    for (const reservation of data.Reservations || []) {
      for (const inst of reservation.Instances || []) {
        const name = inst.Tags?.find((t: any) => t.Key === 'Name')?.Value || '';
        const id = inst.InstanceId || '';
        const state = inst.State?.Name || '';
        const type = inst.InstanceType || '';
        const ip = inst.PrivateIpAddress || '';

        if (level === 'ultra') {
          instances.push(`${id} ${state} ${type}${name ? ' ' + name : ''}`);
        } else {
          instances.push(`${id}  ${state.padEnd(10)} ${type.padEnd(12)} ${ip.padEnd(15)} ${name}`);
        }
      }
    }

    if (instances.length === 0) return { output: 'no instances', strategy: 'aws:ec2:empty' };

    if (level === 'ultra') {
      return { output: instances.join('\n'), strategy: 'aws:ec2:ultra' };
    }

    const header = `${instances.length} instance(s):`;
    return { output: `${header}\n${instances.join('\n')}`, strategy: 'aws:ec2' };
  } catch {
    return filterGenericAws(raw, level);
  }
}

// ── Lambda ────────────────────────────────────────────────────────────────────

function filterLambdaFunctions(raw: string, level: CompressorOptions['level']): FilterResult {
  try {
    const data = JSON.parse(raw);
    const functions = data.Functions || [];

    if (functions.length === 0) return { output: 'no functions', strategy: 'aws:lambda:empty' };

    const lines = functions.map((fn: any) => {
      const name = fn.FunctionName || '';
      const runtime = fn.Runtime || '';
      const memory = fn.MemorySize || '';
      const timeout = fn.Timeout || '';

      if (level === 'ultra') {
        return `${name} ${runtime} ${memory}MB`;
      }
      return `${name.padEnd(40)} ${runtime.padEnd(14)} ${String(memory).padStart(4)}MB  ${String(timeout).padStart(3)}s`;
    });

    if (level === 'ultra') {
      return { output: `${functions.length} functions:\n${lines.join('\n')}`, strategy: 'aws:lambda:ultra' };
    }

    return { output: `${functions.length} function(s):\n${lines.join('\n')}`, strategy: 'aws:lambda' };
  } catch {
    return filterGenericAws(raw, level);
  }
}

// ── CloudWatch Logs ───────────────────────────────────────────────────────────

function filterLogEvents(raw: string, level: CompressorOptions['level']): FilterResult {
  try {
    const data = JSON.parse(raw);
    const events = data.events || [];

    if (events.length === 0) return { output: 'no events', strategy: 'aws:logs:empty' };

    const lines = events.map((e: any) => {
      const ts = new Date(e.timestamp).toISOString().slice(11, 23);
      const msg = (e.message || '').trim();
      return `${ts} ${msg}`;
    });

    // Deduplicate similar consecutive messages
    const deduped: string[] = [];
    let lastPattern = '';
    let repeatCount = 0;

    for (const line of lines) {
      const pattern = line.replace(/\d+/g, 'N');
      if (pattern === lastPattern) {
        repeatCount++;
      } else {
        if (repeatCount > 1) deduped.push(`  …repeated ${repeatCount}x`);
        deduped.push(line);
        lastPattern = pattern;
        repeatCount = 1;
      }
    }
    if (repeatCount > 1) deduped.push(`  …repeated ${repeatCount}x`);

    const maxLines = level === 'ultra' ? 20 : level === 'aggressive' ? 40 : 60;
    const shown = deduped.slice(-maxLines); // Keep tail (most recent)
    const omitted = deduped.length > maxLines ? `…(${deduped.length - maxLines} earlier events omitted)\n` : '';

    return { output: `${omitted}${shown.join('\n')}`, strategy: 'aws:logs' };
  } catch {
    return filterGenericAws(raw, level);
  }
}

// ── CloudFormation ────────────────────────────────────────────────────────────

function filterCfnEvents(raw: string, level: CompressorOptions['level']): FilterResult {
  try {
    const data = JSON.parse(raw);
    const events = data.StackEvents || [];

    if (events.length === 0) return { output: 'no events', strategy: 'aws:cfn:empty' };

    // Sort: failures first, then by timestamp desc
    const sorted = [...events].sort((a: any, b: any) => {
      const aFailed = (a.ResourceStatus || '').includes('FAILED') ? 0 : 1;
      const bFailed = (b.ResourceStatus || '').includes('FAILED') ? 0 : 1;
      if (aFailed !== bFailed) return aFailed - bFailed;
      return new Date(b.Timestamp).getTime() - new Date(a.Timestamp).getTime();
    });

    const lines = sorted.map((e: any) => {
      const status = e.ResourceStatus || '';
      const logical = e.LogicalResourceId || '';
      const reason = e.ResourceStatusReason || '';
      const isFailed = status.includes('FAILED');

      if (level === 'ultra') {
        return `${isFailed ? '✗' : '·'} ${logical} ${status}${reason ? ': ' + reason.slice(0, 60) : ''}`;
      }
      return `${status.padEnd(28)} ${logical}${reason ? '\n  → ' + reason : ''}`;
    });

    const maxLines = level === 'ultra' ? 15 : level === 'aggressive' ? 25 : 40;
    const shown = lines.slice(0, maxLines).join('\n');
    const extra = lines.length > maxLines ? `\n…+${lines.length - maxLines} more events` : '';

    const failures = events.filter((e: any) => (e.ResourceStatus || '').includes('FAILED')).length;
    const header = failures > 0 ? `${failures} FAILED, ${events.length} total events:` : `${events.length} events:`;

    return { output: `${header}\n${shown}${extra}`, strategy: 'aws:cfn' };
  } catch {
    return filterGenericAws(raw, level);
  }
}

// ── DynamoDB ──────────────────────────────────────────────────────────────────

function filterDynamoDB(raw: string, level: CompressorOptions['level']): FilterResult {
  try {
    const data = JSON.parse(raw);

    // Unwrap DynamoDB type annotations: {"S": "value"} → "value", {"N": "123"} → 123
    const unwrapped = unwrapDynamoTypes(data);
    const output = JSON.stringify(unwrapped, null, level === 'ultra' ? 0 : 2);

    return { output, strategy: 'aws:dynamodb' };
  } catch {
    return filterGenericAws(raw, level);
  }
}

function unwrapDynamoTypes(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(unwrapDynamoTypes);
  if (typeof obj !== 'object') return obj;

  // DynamoDB type wrappers: {"S": "..."}, {"N": "..."}, {"BOOL": true}, {"L": [...]}, {"M": {...}}, {"NULL": true}
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const key = keys[0];
    if (key === 'S') return obj.S;
    if (key === 'N') return Number(obj.N);
    if (key === 'BOOL') return obj.BOOL;
    if (key === 'NULL') return null;
    if (key === 'L') return (obj.L as any[]).map(unwrapDynamoTypes);
    if (key === 'M') return unwrapDynamoTypes(obj.M);
    if (key === 'SS') return obj.SS;
    if (key === 'NS') return (obj.NS as string[]).map(Number);
    if (key === 'BS') return obj.BS;
  }

  // Recurse into regular objects
  const result: any = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = unwrapDynamoTypes(v);
  }
  return result;
}

// ── IAM ───────────────────────────────────────────────────────────────────────

function filterIamRoles(raw: string, level: CompressorOptions['level']): FilterResult {
  try {
    const data = JSON.parse(raw);
    const roles = data.Roles || [];

    if (roles.length === 0) return { output: 'no roles', strategy: 'aws:iam-roles:empty' };

    // Strip AssumeRolePolicyDocument (verbose, rarely needed in listing)
    const lines = roles.map((r: any) => {
      const name = r.RoleName || '';
      const path = r.Path || '/';
      const created = r.CreateDate ? r.CreateDate.slice(0, 10) : '';

      if (level === 'ultra') return name;
      return `${name.padEnd(40)} ${path.padEnd(10)} ${created}`;
    });

    const maxLines = level === 'ultra' ? 30 : level === 'aggressive' ? 40 : 60;
    const shown = lines.slice(0, maxLines).join('\n');
    const extra = lines.length > maxLines ? `\n…+${lines.length - maxLines} more` : '';

    return { output: `${roles.length} roles:\n${shown}${extra}`, strategy: 'aws:iam-roles' };
  } catch {
    return filterGenericAws(raw, level);
  }
}

function filterIamPolicies(raw: string, level: CompressorOptions['level']): FilterResult {
  try {
    const data = JSON.parse(raw);
    const policies = data.Policies || [];

    if (policies.length === 0) return { output: 'no policies', strategy: 'aws:iam-policies:empty' };

    const lines = policies.map((p: any) => {
      if (level === 'ultra') return p.PolicyName || '';
      return `${(p.PolicyName || '').padEnd(40)} ${p.Arn || ''}`;
    });

    const maxLines = level === 'ultra' ? 30 : 50;
    const shown = lines.slice(0, maxLines).join('\n');
    const extra = lines.length > maxLines ? `\n…+${lines.length - maxLines} more` : '';

    return { output: `${policies.length} policies:\n${shown}${extra}`, strategy: 'aws:iam-policies' };
  } catch {
    return filterGenericAws(raw, level);
  }
}

// ── S3 ────────────────────────────────────────────────────────────────────────

function filterS3Ls(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());

  if (lines.length === 0) return { output: 'empty', strategy: 'aws:s3-ls:empty' };
  if (lines.length <= 20) return { output: raw, strategy: 'aws:s3-ls:short' };

  if (level === 'ultra') {
    return { output: `${lines.length} objects`, strategy: 'aws:s3-ls:ultra' };
  }

  const maxLines = level === 'aggressive' ? 30 : 50;
  const shown = lines.slice(0, maxLines).join('\n');
  const extra = lines.length > maxLines ? `\n…+${lines.length - maxLines} more objects` : '';

  return { output: `${shown}${extra}`, strategy: 'aws:s3-ls' };
}

function filterS3Transfer(raw: string, level: CompressorOptions['level']): FilterResult {
  const lines = raw.split('\n').filter(l => l.trim());

  // Strip progress lines (Completed X.X MiB/...)
  const meaningful = lines.filter(l => !l.includes('Completed') && !l.includes('upload:') || l.includes('upload: s3://'));

  if (meaningful.length === 0) return { output: 'ok', strategy: 'aws:s3-transfer' };

  if (level === 'ultra') {
    const count = lines.filter(l => l.includes('upload:') || l.includes('copy:')).length;
    return { output: `ok ${count} objects`, strategy: 'aws:s3-transfer:ultra' };
  }

  return { output: meaningful.slice(0, 20).join('\n'), strategy: 'aws:s3-transfer' };
}

// ── ECS ───────────────────────────────────────────────────────────────────────

function filterEcsTasks(raw: string, level: CompressorOptions['level']): FilterResult {
  try {
    const data = JSON.parse(raw);
    const tasks = data.tasks || data.taskArns || [];

    if (tasks.length === 0) return { output: 'no tasks', strategy: 'aws:ecs-tasks:empty' };

    if (Array.isArray(tasks) && typeof tasks[0] === 'string') {
      // taskArns — just ARNs
      const short = tasks.map((arn: string) => arn.split('/').pop());
      return { output: `${tasks.length} tasks:\n${short.join('\n')}`, strategy: 'aws:ecs-tasks' };
    }

    const lines = tasks.map((t: any) => {
      const id = (t.taskArn || '').split('/').pop();
      const status = t.lastStatus || '';
      const group = t.group || '';
      if (level === 'ultra') return `${id} ${status}`;
      return `${id}  ${status.padEnd(10)} ${group}`;
    });

    return { output: `${tasks.length} tasks:\n${lines.join('\n')}`, strategy: 'aws:ecs-tasks' };
  } catch {
    return filterGenericAws(raw, level);
  }
}

function filterEcsServices(raw: string, level: CompressorOptions['level']): FilterResult {
  try {
    const data = JSON.parse(raw);
    const services = data.services || [];

    if (services.length === 0) return { output: 'no services', strategy: 'aws:ecs-services:empty' };

    const lines = services.map((s: any) => {
      const name = s.serviceName || '';
      const status = s.status || '';
      const running = s.runningCount ?? 0;
      const desired = s.desiredCount ?? 0;
      if (level === 'ultra') return `${name} ${running}/${desired}`;
      return `${name.padEnd(30)} ${status.padEnd(8)} ${running}/${desired} tasks`;
    });

    return { output: `${services.length} services:\n${lines.join('\n')}`, strategy: 'aws:ecs-services' };
  } catch {
    return filterGenericAws(raw, level);
  }
}

// ── SQS / SNS ─────────────────────────────────────────────────────────────────

function filterSqsQueues(raw: string, level: CompressorOptions['level']): FilterResult {
  try {
    const data = JSON.parse(raw);
    const urls = data.QueueUrls || [];
    if (urls.length === 0) return { output: 'no queues', strategy: 'aws:sqs:empty' };

    const names = urls.map((url: string) => url.split('/').pop());
    if (level === 'ultra') return { output: `${names.length} queues`, strategy: 'aws:sqs:ultra' };
    return { output: `${names.length} queues:\n${names.join('\n')}`, strategy: 'aws:sqs' };
  } catch {
    return filterGenericAws(raw, level);
  }
}

function filterSnsTopics(raw: string, level: CompressorOptions['level']): FilterResult {
  try {
    const data = JSON.parse(raw);
    const topics = data.Topics || [];
    if (topics.length === 0) return { output: 'no topics', strategy: 'aws:sns:empty' };

    const arns = topics.map((t: any) => (t.TopicArn || '').split(':').pop());
    if (level === 'ultra') return { output: `${arns.length} topics`, strategy: 'aws:sns:ultra' };
    return { output: `${arns.length} topics:\n${arns.join('\n')}`, strategy: 'aws:sns' };
  } catch {
    return filterGenericAws(raw, level);
  }
}

// ── Generic AWS fallback ──────────────────────────────────────────────────────

function filterGenericAws(raw: string, level: CompressorOptions['level']): FilterResult {
  // Try to parse as JSON and strip common verbose fields
  try {
    const data = JSON.parse(raw);
    const stripped = stripAwsVerboseFields(data);
    const indent = level === 'ultra' ? 0 : 2;
    const output = JSON.stringify(stripped, null, indent);

    // Truncate if still too long
    const maxChars = level === 'ultra' ? 2000 : level === 'aggressive' ? 5000 : 10000;
    if (output.length > maxChars) {
      return { output: output.slice(0, maxChars) + '\n…(truncated)', strategy: 'aws:generic:truncated' };
    }

    return { output, strategy: 'aws:generic:json' };
  } catch {
    // Not JSON — apply line-based truncation
    const lines = raw.split('\n');
    const maxLines = level === 'ultra' ? 20 : level === 'aggressive' ? 40 : 60;
    if (lines.length <= maxLines) return { output: raw, strategy: 'aws:generic:text' };

    const shown = lines.slice(0, maxLines).join('\n');
    return { output: `${shown}\n…+${lines.length - maxLines} more lines`, strategy: 'aws:generic:truncated' };
  }
}

/**
 * Strip commonly verbose AWS fields that add noise without actionable info.
 */
function stripAwsVerboseFields(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripAwsVerboseFields);
  if (typeof obj !== 'object') return obj;

  const STRIP_KEYS = new Set([
    'AssumeRolePolicyDocument',
    'PolicyDocument',
    'Document',
    'ResponseMetadata',
    'Marker',
    'IsTruncated',
  ]);

  const result: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRIP_KEYS.has(k)) continue;
    result[k] = stripAwsVerboseFields(v);
  }
  return result;
}
