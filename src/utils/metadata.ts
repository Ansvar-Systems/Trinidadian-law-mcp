/**
 * Response metadata utilities for Trinidad and Tobago Law MCP.
 */

import type Database from '@ansvar/mcp-sqlite';

export interface ResponseMetadata {
  data_source: string;
  jurisdiction: string;
  disclaimer: string;
  freshness?: string;
}

export interface ToolResponse<T> {
  results: T;
  _metadata: ResponseMetadata;
}

export function generateResponseMetadata(
  db: InstanceType<typeof Database>,
): ResponseMetadata {
  let freshness: string | undefined;
  try {
    const row = db.prepare(
      "SELECT value FROM db_metadata WHERE key = 'built_at'"
    ).get() as { value: string } | undefined;
    if (row) freshness = row.value;
  } catch {
    // Ignore
  }

  return {
    data_source: 'Digital Legislative Library of Trinidad and Tobago (laws.gov.tt) -- Government of Trinidad and Tobago',
    jurisdiction: 'TT',
    disclaimer:
      'This data is sourced from the Digital Legislative Library of Trinidad and Tobago under Government Publication principles. ' +
      'The authoritative versions are in English. ' +
      'Always verify with the official portal (laws.gov.tt).',
    freshness,
  };
}
