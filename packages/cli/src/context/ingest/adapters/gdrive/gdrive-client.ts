import { JWT } from 'google-auth-library';
import type { GdriveFileRecord, GdriveServiceAccountKey, GoogleDocsDocument } from './types.js';
import { GDRIVE_SCOPES, gdriveServiceAccountKeySchema } from './types.js';

const GOOGLE_DRIVE_BASE_URL = 'https://www.googleapis.com/drive/v3';
const GOOGLE_DOCS_BASE_URL = 'https://docs.googleapis.com/v1';

interface GoogleApiListResponse {
  files?: Array<{
    id?: string;
    name?: string;
    mimeType?: string;
    parents?: string[];
    webViewLink?: string;
    modifiedTime?: string;
  }>;
  nextPageToken?: string;
}

interface GoogleApiFile {
  id?: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  webViewLink?: string;
  modifiedTime?: string;
}

async function parseGoogleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google API request failed (${response.status}): ${body || response.statusText}`);
  }
  return (await response.json()) as T;
}

async function authorizedFetch(client: JWT, url: string): Promise<Response> {
  const headers = await client.getRequestHeaders(url);
  return fetch(url, { headers });
}

function isGoogleApiFileRecord(file: GoogleApiFile): file is GoogleApiFile & {
  id: string;
  name: string;
  mimeType: string;
} {
  return typeof file.id === 'string' && typeof file.name === 'string' && typeof file.mimeType === 'string';
}

export function createGoogleDocsClients(rawKey: unknown): {
  drive: {
    listFiles(args: { q: string; pageToken?: string }): Promise<{ files: GdriveFileRecord[]; nextPageToken: string | null }>;
  };
  docs: {
    getDocument(documentId: string): Promise<GoogleDocsDocument>;
  };
} {
  const key = gdriveServiceAccountKeySchema.parse(rawKey) satisfies GdriveServiceAccountKey;
  const client = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [...GDRIVE_SCOPES],
  });

  return {
    drive: {
      async listFiles(args) {
        const params = new URLSearchParams({
          q: args.q,
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          pageSize: '1000',
          fields: 'nextPageToken,files(id,name,mimeType,parents,webViewLink,modifiedTime)',
        });
        if (args.pageToken) {
          params.set('pageToken', args.pageToken);
        }
        const response = await authorizedFetch(client, `${GOOGLE_DRIVE_BASE_URL}/files?${params.toString()}`);
        const parsed = await parseGoogleResponse<GoogleApiListResponse>(response);
        return {
          files: (parsed.files ?? [])
            .filter(isGoogleApiFileRecord)
            .map((file) => ({
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              parents: Array.isArray(file.parents) ? file.parents.filter((parent): parent is string => typeof parent === 'string') : [],
              webViewLink: typeof file.webViewLink === 'string' ? file.webViewLink : null,
              modifiedTime: typeof file.modifiedTime === 'string' ? file.modifiedTime : null,
            })),
          nextPageToken: typeof parsed.nextPageToken === 'string' ? parsed.nextPageToken : null,
        };
      },
    },
    docs: {
      async getDocument(documentId: string) {
        const params = new URLSearchParams({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        });
        const response = await authorizedFetch(client, `${GOOGLE_DOCS_BASE_URL}/documents/${documentId}?${params.toString()}`);
        return await parseGoogleResponse<GoogleDocsDocument>(response);
      },
    },
  };
}
