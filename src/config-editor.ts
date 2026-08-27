import { normalizeConfig } from './config';
import type { ConnectionConfig } from './types';

export interface ConfigFields {
  esUrl: HTMLInputElement;
  apiKey: HTMLInputElement;
  indexPrefix: HTMLInputElement;
}

export function configFromFields(fields: ConfigFields): ConnectionConfig {
  return normalizeConfig({ esUrl: fields.esUrl.value, apiKey: fields.apiKey.value, indexPrefix: fields.indexPrefix.value });
}

export function serializeConfig(config: Pick<ConnectionConfig, 'esUrl' | 'apiKey' | 'indexPrefix'>): string {
  return JSON.stringify({ esUrl: config.esUrl, apiKey: config.apiKey, indexPrefix: config.indexPrefix }, null, 2);
}

export function parseConfigJson(value: string): ConnectionConfig {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('JSON 格式不正确，请检查逗号、引号和括号。'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('JSON 配置必须是对象。');
  const config = parsed as Partial<Record<'esUrl' | 'apiKey' | 'indexPrefix', unknown>>;
  if (typeof config.esUrl !== 'string' || typeof config.apiKey !== 'string' || typeof config.indexPrefix !== 'string') {
    throw new Error('JSON 配置必须包含 esUrl、apiKey 和 indexPrefix 字符串字段。');
  }
  return normalizeConfig({ esUrl: config.esUrl, apiKey: config.apiKey, indexPrefix: config.indexPrefix });
}

export function writeConfigFields(fields: ConfigFields, config: ConnectionConfig | null): void {
  fields.esUrl.value = config?.esUrl ?? '';
  fields.apiKey.value = config?.apiKey ?? '';
  fields.indexPrefix.value = config?.indexPrefix ?? '';
}
