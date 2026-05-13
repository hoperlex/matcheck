import type { EdoAdapter, EdoCredentials, EdoIncomingDocument } from './adapter.js';

const DIADOC_BASE = 'https://diadoc-api.kontur.ru';

// NOTE: реальная интеграция с Diadoc API требует X-Authentication
// (Authenticate + Authentication header). Реализован каркас — для прод-использования
// необходимо обновить под актуальную версию API и заполнить парсинг ответов.
// Документация: https://api-docs.kontur.ru/diadoc

export class DiadocAdapter implements EdoAdapter {
  private token: string | null = null;

  constructor(private readonly creds: EdoCredentials) {}

  private async authenticate(): Promise<string> {
    if (this.token) return this.token;
    const res = await fetch(`${DIADOC_BASE}/V3/Authenticate?type=password`, {
      method: 'POST',
      headers: {
        Authorization: `DiadocAuth ddauth_api_client_id=${this.creds.apiClientId}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ login: this.creds.login, password: this.creds.password }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`Diadoc auth failed: HTTP ${res.status}`);
    }
    this.token = await res.text();
    return this.token;
  }

  async listIncoming(since?: Date): Promise<EdoIncomingDocument[]> {
    const token = await this.authenticate();
    const fromTimestamp = since
      ? Math.floor(since.getTime() / 1000)
      : Math.floor(Date.now() / 1000) - 86400;
    const url = new URL(`${DIADOC_BASE}/V3/GetDocumentsByMessageId`);
    url.searchParams.set('boxId', this.creds.boxId);
    url.searchParams.set('filterCategory', 'Any.Inbound');
    url.searchParams.set('timestampFrom', String(fromTimestamp));
    const res = await fetch(url, {
      headers: {
        Authorization: `DiadocAuth ddauth_api_client_id=${this.creds.apiClientId}, ddauth_token=${token}`,
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Diadoc list failed: HTTP ${res.status}`);
    const data = (await res.json()) as {
      Documents?: { MessageId: string; CreationTimestampTicks?: string; EntityId?: string }[];
    };
    const docs = data.Documents ?? [];
    const result: EdoIncomingDocument[] = [];
    for (const d of docs) {
      const xml = await this.fetchXml(token, d.MessageId, d.EntityId ?? '');
      if (xml) {
        result.push({
          providerMessageId: d.MessageId,
          receivedAt: new Date(),
          xml,
        });
      }
    }
    return result;
  }

  private async fetchXml(
    token: string,
    messageId: string,
    entityId: string,
  ): Promise<string | null> {
    const url = new URL(`${DIADOC_BASE}/V3/GetEntityContent`);
    url.searchParams.set('boxId', this.creds.boxId);
    url.searchParams.set('messageId', messageId);
    url.searchParams.set('entityId', entityId);
    const res = await fetch(url, {
      headers: {
        Authorization: `DiadocAuth ddauth_api_client_id=${this.creds.apiClientId}, ddauth_token=${token}`,
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.toString('utf-8');
  }

  async markProcessed(_providerMessageId: string): Promise<void> {
    // Diadoc не требует отметки обработки на стороне API; идемпотентность обеспечивается
    // UNIQUE-индексом (edo_account_id, provider_message_id) в БД.
  }
}
