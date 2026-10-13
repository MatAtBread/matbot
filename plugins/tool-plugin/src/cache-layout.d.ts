export declare function verbatimCachePath(url: string, dotPlugins: string): string;
export declare function urlToCachePath(url: string, dotPlugins: string): string;
export declare function cachedModulePath(url: string, dotPlugins: string): string | undefined;
export declare function candidatesFor(url: string): string[];
export declare function storeModule(p: string, body: string, url: string, dotPlugins: string): Promise<void>;
