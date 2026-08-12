import { CliError, UsageError } from '../../cli/output.js';
import { buildMailgunUrl, mailgunRequest } from '../../core/mailgun.js';
import type { DataGap } from '../../core/types.js';
import { asRecord, stringOrNull } from './preview-values.js';

interface RenderAsset {
  name: string;
  url: string;
}

export interface PreviewRenderMetadata {
  test_id: string;
  client_id: string;
  display_name: string | null;
  client: string | null;
  os: string | null;
  browser: string | null;
  category: string | null;
  status: string | null;
  available_variants: string[];
  selected_variant: string | null;
  data_gaps: DataGap[];
}

export interface PreviewRenderLookup {
  metadata: PreviewRenderMetadata;
  selectedAssetUrl: string | null;
}

function renderAssets(record: Record<string, unknown>): RenderAsset[] {
  const assets: RenderAsset[] = [];
  for (const [name, value] of Object.entries(asRecord(record.screenshots))) {
    if (typeof value === 'string' && value.length > 0) assets.push({ name, url: value });
  }
  for (const name of ['thumbnail', 'full_thumbnail'] as const) {
    const value = record[name];
    if (typeof value === 'string' && value.length > 0) assets.push({ name, url: value });
  }
  return assets.sort((a, b) => a.name.localeCompare(b.name));
}

function defaultRenderAsset(assets: RenderAsset[]): RenderAsset | null {
  return assets.find((asset) => asset.name === 'default')
    ?? assets.find((asset) => asset.name !== 'full_thumbnail' && asset.name !== 'thumbnail')
    ?? assets.find((asset) => asset.name === 'full_thumbnail')
    ?? assets.find((asset) => asset.name === 'thumbnail')
    ?? null;
}

export async function getPreviewRender(params: {
  apiKey: string;
  baseUrl: string;
  testId: string;
  clientId: string;
  variant?: string;
  selectAsset?: boolean;
}): Promise<PreviewRenderLookup> {
  const url = buildMailgunUrl(
    `/v2/preview/tests/${encodeURIComponent(params.testId)}/results/${encodeURIComponent(params.clientId)}`,
    undefined,
    params.baseUrl
  );
  const response = await mailgunRequest<unknown>(url, params.apiKey, 'preview client result');
  const responseRecord = asRecord(response);
  const selectedRecord = asRecord(responseRecord[params.clientId]);
  const record = Object.keys(selectedRecord).length > 0
    ? selectedRecord
    : asRecord(Object.values(responseRecord)[0]);
  if (Object.keys(record).length === 0) {
    throw new CliError(`Mailgun returned no render for client ${params.clientId}`);
  }

  const assets = renderAssets(record);
  const selected = params.variant !== undefined
    ? assets.find((asset) => asset.name === params.variant) ?? null
    : params.selectAsset === true
      ? defaultRenderAsset(assets)
      : null;
  if (params.variant !== undefined && selected === null) {
    throw new UsageError(
      `render variant '${params.variant}' is unavailable; choose one of: ${assets.map((asset) => asset.name).join(', ') || 'none'}`
    );
  }
  if (params.selectAsset === true && selected === null) {
    throw new UsageError(`Mailgun returned no screenshot assets for client ${params.clientId}`);
  }

  return {
    metadata: {
      test_id: params.testId,
      client_id: stringOrNull(record.id) ?? params.clientId,
      display_name: stringOrNull(record.display_name),
      client: stringOrNull(record.client),
      os: stringOrNull(record.os),
      browser: stringOrNull(record.browser),
      category: stringOrNull(record.category),
      status: stringOrNull(record.status),
      available_variants: assets.map((asset) => asset.name),
      selected_variant: selected?.name ?? null,
      data_gaps: []
    },
    selectedAssetUrl: selected?.url ?? null
  };
}
