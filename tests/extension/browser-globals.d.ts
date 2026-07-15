export {};

declare global {
  const chrome: {
    permissions: {
      contains(details: { origins: string[] }): Promise<boolean>;
    };
    storage: {
      local: {
        get(key: string | null): Promise<Record<string, unknown>>;
      };
    };
  };

  interface Window {
    fixtureSeekSeconds(): number;
    navigateFixture(videoId: string): void;
  }
}
