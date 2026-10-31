export declare function mirrorPath(url: string, dotPlugins: string): string;
export declare function mirroredFile(url: string, dotPlugins: string): string | undefined;
export declare function candidatesFor(url: string): string[];
export declare function schemeFor(hostDir: string): string;
export declare function recordOrigin(dotPlugins: string, url: string): Promise<void>;
