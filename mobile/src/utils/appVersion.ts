import * as Application from 'expo-application';
import Constants, { ExecutionEnvironment } from 'expo-constants';

export interface VersionParts {
  version?: string | null;
  build?: string | null;
  commit?: string | null;
  builtAt?: string | null;
  expoGo?: boolean;
}

// "Version 1.0.0 · build 7 · 5211c72" - whatever parts are known, in that order.
export function formatVersionLabel({ version, build, commit, expoGo }: VersionParts): string {
  if (expoGo) return 'Running in Expo Go (development)';
  const parts: string[] = [];
  if (version) parts.push(`Version ${version}`);
  if (build) parts.push(`build ${build}`);
  if (commit) parts.push(commit);
  return parts.join(' · ') || 'Version unknown';
}

export function getVersionParts(): VersionParts {
  const extra = (Constants.expoConfig?.extra ?? {}) as { gitCommit?: string; builtAt?: string };
  return {
    version: Application.nativeApplicationVersion ?? Constants.expoConfig?.version,
    build: Application.nativeBuildVersion,
    commit: extra.gitCommit,
    builtAt: extra.builtAt,
    expoGo: Constants.executionEnvironment === ExecutionEnvironment.StoreClient,
  };
}
