export interface GitAuthor {
  name: string;
  email: string;
}

export interface GitAuthorResolverPort {
  resolve(userId: string | null | undefined): Promise<GitAuthor>;
}

export const SYSTEM_GIT_AUTHOR: GitAuthor = {
  name: 'System User',
  email: 'system@example.com',
};
