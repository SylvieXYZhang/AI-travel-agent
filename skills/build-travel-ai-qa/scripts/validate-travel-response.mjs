#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const modes = new Set(['EXPLORE', 'PLAN', 'CLARIFY']);
const intents = new Set(['recommend_destinations', 'create_plan', 'modify_current', 'answer_question', 'update_profile', 'clarify']);
const mutationIntents = new Set(['create_plan', 'modify_current', 'update_profile']);
const allowedByMode = {
  EXPLORE: new Set(['recommend_destinations', 'answer_question', 'clarify', 'update_profile']),
  PLAN: new Set(['create_plan', 'modify_current', 'answer_question', 'clarify', 'update_profile']),
  CLARIFY: new Set(['clarify'])
};
const topKeys = new Set(['mode', 'intent', 'assistant_message', 'requires_confirmation', 'missing_fields', 'proposal', 'results', 'citations', 'warnings']);

export function validateTravelResponse(value, evidence = []) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['response must be an object'];
  for (const key of Object.keys(value)) if (!topKeys.has(key)) errors.push(`unknown top-level key: ${key}`);
  for (const key of topKeys) if (!(key in value)) errors.push(`missing top-level key: ${key}`);
  if (!modes.has(value.mode)) errors.push('invalid mode');
  if (!intents.has(value.intent)) errors.push('invalid intent');
  if (modes.has(value.mode) && intents.has(value.intent) && !allowedByMode[value.mode].has(value.intent)) errors.push('intent is not allowed for mode');
  if (typeof value.assistant_message !== 'string' || !value.assistant_message.trim()) errors.push('assistant_message must be a non-empty string');
  if (typeof value.requires_confirmation !== 'boolean') errors.push('requires_confirmation must be boolean');
  if (!Array.isArray(value.missing_fields)) errors.push('missing_fields must be an array');
  if (!Array.isArray(value.results)) errors.push('results must be an array');
  if (!Array.isArray(value.citations)) errors.push('citations must be an array');
  if (!Array.isArray(value.warnings)) errors.push('warnings must be an array');

  const isMutation = mutationIntents.has(value.intent);
  if (isMutation && value.requires_confirmation !== true) errors.push('mutation intent requires confirmation');
  if (isMutation && (!value.proposal || typeof value.proposal !== 'object' || Array.isArray(value.proposal))) errors.push('mutation intent requires a proposal object');
  if (!isMutation && value.proposal !== null) errors.push('non-mutation intent must use proposal=null');
  if (isMutation && value.proposal) {
    if (value.proposal.operation !== value.intent) errors.push('proposal operation must match intent');
    if (value.proposal.preserve_unmentioned !== true) errors.push('proposal must preserve unmentioned fields');
    if (!value.proposal.patch || typeof value.proposal.patch !== 'object' || Array.isArray(value.proposal.patch)) errors.push('proposal patch must be an object');
    if (typeof value.proposal.summary !== 'string' || !value.proposal.summary.trim()) errors.push('proposal summary must be a non-empty string');
  }

  const evidenceById = new Map(evidence.map(item => [item.id, item]));
  if (Array.isArray(value.citations)) {
    for (const [index, citation] of value.citations.entries()) {
      if (!citation || typeof citation !== 'object') {
        errors.push(`citation ${index} must be an object`);
        continue;
      }
      if (!citation.id) errors.push(`citation ${index} is missing id`);
      if (evidence.length) {
        const source = evidenceById.get(citation.id);
        if (!source) errors.push(`citation ${index} references unknown evidence id`);
        else if (citation.url !== source.url) errors.push(`citation ${index} URL does not match evidence`);
      }
    }
  }
  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const value = JSON.parse(readFileSync(0, 'utf8'));
    const errors = validateTravelResponse(value);
    if (errors.length) {
      console.error(JSON.stringify({ valid: false, errors }, null, 2));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ valid: true }));
    }
  } catch (error) {
    console.error(JSON.stringify({ valid: false, errors: [error.message] }, null, 2));
    process.exitCode = 1;
  }
}
