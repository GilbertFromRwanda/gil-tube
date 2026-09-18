import { SearchResult } from './api/types';

export type RootStackParamList = {
  Search: undefined;
  Preview: { result?: SearchResult; url?: string };
  Download: { jobId: string; title?: string; container?: string };
  Settings: undefined;
  ScanQr: undefined;
};
