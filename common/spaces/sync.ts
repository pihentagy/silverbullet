import { renderToText, replaceNodesMatching } from "../../plug-api/lib/tree.ts";
import buildMarkdown from "../markdown_parser/parser.ts";
import { parse } from "../markdown_parser/parse_tree.ts";
import type { FileMeta } from "../types.ts";
import { SpacePrimitives } from "./space_primitives.ts";

type SyncHash = number;

// Tuple where the first value represents a lastModified timestamp for the primary space
// and the second item the lastModified value of the secondary space
export type SyncStatusItem = [SyncHash, SyncHash];

export type SyncStatus = {
  filesProcessed: number;
  totalFiles: number;
  snapshot: Map<string, SyncStatusItem>;
};

export type SyncOptions = {
  conflictResolver: (
    name: string,
    snapshot: Map<string, SyncStatusItem>,
    primarySpace: SpacePrimitives,
    secondarySpace: SpacePrimitives,
  ) => Promise<number>;
  isSyncCandidate?: (path: string) => boolean;
  // Used to track progress, may want to pass more specific info later
  onSyncProgress?: (syncStatus: SyncStatus) => void;
};

// Implementation of this algorithm https://unterwaditzer.net/2016/sync-algorithm.html
export class SpaceSync {
  constructor(
    private primary: SpacePrimitives,
    private secondary: SpacePrimitives,
    readonly options: SyncOptions,
  ) {
  }

  async syncFiles(snapshot: Map<string, SyncStatusItem>): Promise<number> {
    let operations = 0;
    console.log("[sync]", "Fetching snapshot from primary");
    const primaryAllPages = this.syncCandidates(
      await this.primary.fetchFileList(),
    );

    console.log("[sync]", "Fetching snapshot from secondary");
    try {
      const secondaryAllPages = this.syncCandidates(
        await this.secondary.fetchFileList(),
      );

      const primaryFileMap = new Map<string, SyncHash>(
        primaryAllPages.map((m) => [m.name, m.lastModified]),
      );
      const secondaryFileMap = new Map<string, SyncHash>(
        secondaryAllPages.map((m) => [m.name, m.lastModified]),
      );

      const allFilesToProcess = new Set([
        ...snapshot.keys(),
        ...primaryFileMap.keys(),
        ...secondaryFileMap.keys(),
      ]);

      const sortedFilenames = [...allFilesToProcess];
      sortedFilenames.sort((a) => {
        // Just make sure that _plug/ files appear first
        // This is important for the initial sync: plugs are loaded the moment they are pulled into the space,
        // which would activate e.g. any indexing logic for the remaining space content
        return a.startsWith("_plug/") ? -1 : 1;
      });
      // console.log("[sync]", "Iterating over all files");
      let filesProcessed = 0;
      for (const name of sortedFilenames) {
        try {
          operations += await this.syncFile(
            snapshot,
            name,
            primaryFileMap.get(name),
            secondaryFileMap.get(name),
          );
          filesProcessed++;
          if (operations > 0 && this.options.onSyncProgress) {
            this.options.onSyncProgress({
              filesProcessed,
              totalFiles: sortedFilenames.length,
              snapshot,
            });
          }
        } catch (e: any) {
          console.log("error", "Error syncing file", name, e.message);
        }
      }
    } catch (e: any) {
      console.log("error", "General sync error:", e.message);
      throw e;
    }
    console.log("[sync]", "Sync complete, operations performed", operations);

    return operations;
  }

  async syncFile(
    snapshot: Map<string, SyncStatusItem>,
    name: string,
    primaryHash: SyncHash | undefined,
    secondaryHash: SyncHash | undefined,
  ): Promise<number> {
    if (this.options.isSyncCandidate && !this.options.isSyncCandidate(name)) {
      return 0;
    }
    // console.log("Syncing", name, primaryHash, secondaryHash);
    let operations = 0;

    if (
      primaryHash !== undefined && secondaryHash === undefined &&
      !snapshot.has(name)
    ) {
      // New file, created on primary, copy from primary to secondary
      console.log(
        "[sync]",
        "New file created on primary, copying to secondary",
        name,
      );
      const { data, meta } = await this.primary.readFile(name);
      const writtenMeta = await this.secondary.writeFile(
        name,
        data,
        false,
        meta.lastModified,
      );
      snapshot.set(name, [
        primaryHash,
        writtenMeta.lastModified,
      ]);
      operations++;
    } else if (
      secondaryHash !== undefined && primaryHash === undefined &&
      !snapshot.has(name)
    ) {
      // New file, created on secondary, copy from secondary to primary
      console.log(
        "[sync]",
        "New file created on secondary, copying from secondary to primary",
        name,
      );
      const { data, meta } = await this.secondary.readFile(name);
      const writtenMeta = await this.primary.writeFile(
        name,
        data,
        false,
        meta.lastModified,
      );
      snapshot.set(name, [
        writtenMeta.lastModified,
        secondaryHash,
      ]);
      operations++;
    } else if (
      primaryHash !== undefined && snapshot.has(name) &&
      secondaryHash === undefined
    ) {
      // File deleted on B
      console.log(
        "[sync]",
        "File deleted on secondary, deleting from primary",
        name,
      );
      await this.primary.deleteFile(name);
      snapshot.delete(name);
      operations++;
    } else if (
      secondaryHash !== undefined && snapshot.has(name) &&
      primaryHash === undefined
    ) {
      // File deleted on A
      console.log(
        "[sync]",
        "File deleted on primary, deleting from secondary",
        name,
      );
      await this.secondary.deleteFile(name);
      snapshot.delete(name);
      operations++;
    } else if (
      snapshot.has(name) && primaryHash === undefined &&
      secondaryHash === undefined
    ) {
      // File deleted on both sides, :shrug:
      console.log(
        "[sync]",
        "File deleted on both ends, deleting from status",
        name,
      );
      snapshot.delete(name);
      operations++;
    } else if (
      primaryHash !== undefined && secondaryHash !== undefined &&
      snapshot.get(name) &&
      primaryHash !== snapshot.get(name)![0] &&
      secondaryHash === snapshot.get(name)![1]
    ) {
      // File has changed on primary, but not secondary: copy from primary to secondary
      console.log(
        "[sync]",
        "File changed on primary, copying to secondary",
        name,
      );
      const { data, meta } = await this.primary.readFile(name);
      const writtenMeta = await this.secondary.writeFile(
        name,
        data,
        false,
        meta.lastModified,
      );
      snapshot.set(name, [
        primaryHash,
        writtenMeta.lastModified,
      ]);
      operations++;
    } else if (
      primaryHash !== undefined && secondaryHash !== undefined &&
      snapshot.get(name) &&
      secondaryHash !== snapshot.get(name)![1] &&
      primaryHash === snapshot.get(name)![0]
    ) {
      // File has changed on secondary, but not primary: copy from secondary to primary
      console.log(
        "[sync]",
        "File has changed on secondary, but not primary: copy from secondary to primary",
        name,
      );
      const { data, meta } = await this.secondary.readFile(name);
      const writtenMeta = await this.primary.writeFile(
        name,
        data,
        false,
        meta.lastModified,
      );
      snapshot.set(name, [
        writtenMeta.lastModified,
        secondaryHash,
      ]);
      operations++;
    } else if (
      ( // File changed on both ends, but we don't have any info in the snapshot (resync scenario?): have to run through conflict handling
        primaryHash !== undefined && secondaryHash !== undefined &&
        !snapshot.has(name)
      ) ||
      ( // File changed on both ends, CONFLICT!
        primaryHash && secondaryHash &&
        snapshot.get(name) &&
        secondaryHash !== snapshot.get(name)![1] &&
        primaryHash !== snapshot.get(name)![0]
      )
    ) {
      console.log(
        "[sync]",
        "File changed on both ends, potential conflict",
        name,
      );
      operations += await this.options.conflictResolver!(
        name,
        snapshot,
        this.primary,
        this.secondary,
      );
    } else {
      // Nothing needs to happen
    }
    return operations;
  }

  // Strategy: Primary wins
  public static async primaryConflictResolver(
    name: string,
    snapshot: Map<string, SyncStatusItem>,
    primary: SpacePrimitives,
    secondary: SpacePrimitives,
  ): Promise<number> {
    console.log("[sync]", "Starting conflict resolution for", name);
    const filePieces = name.split(".");
    const fileNameBase = filePieces.slice(0, -1).join(".");
    const fileNameExt = filePieces[filePieces.length - 1];
    const pageData1 = await primary.readFile(name);
    const pageData2 = await secondary.readFile(name);

    if (name.endsWith(".md")) {
      console.log(
        "[sync]",
        "File is markdown, using smart conflict resolution",
      );
      // Let's use a smartert check for markdown files, ignoring directive bodies
      const pageText1 = removeDirectiveBody(
        new TextDecoder().decode(pageData1.data),
      );
      const pageText2 = removeDirectiveBody(
        new TextDecoder().decode(pageData2.data),
      );
      if (pageText1 === pageText2) {
        console.log(
          "[sync]",
          "Files are the same (eliminating the directive bodies), no conflict",
        );
        snapshot.set(name, [
          pageData1.meta.lastModified,
          pageData2.meta.lastModified,
        ]);
        return 0;
      }
    } else {
      let byteWiseMatch = true;
      const arrayBuffer1 = pageData1.data;
      const arrayBuffer2 = pageData2.data;
      if (arrayBuffer1.byteLength !== arrayBuffer2.byteLength) {
        byteWiseMatch = false;
      }
      if (byteWiseMatch) {
        // Byte-wise comparison
        for (let i = 0; i < arrayBuffer1.byteLength; i++) {
          if (arrayBuffer1[i] !== arrayBuffer2[i]) {
            byteWiseMatch = false;
            break;
          }
        }
        // Byte wise they're still the same, so no confict
        if (byteWiseMatch) {
          console.log("[sync]", "Files are the same, no conflict");

          snapshot.set(name, [
            pageData1.meta.lastModified,
            pageData2.meta.lastModified,
          ]);
          return 0;
        }
      }
    }
    const revisionFileName = filePieces.length === 1
      ? `${name}.conflicted.${pageData2.meta.lastModified}`
      : `${fileNameBase}.conflicted.${pageData2.meta.lastModified}.${fileNameExt}`;
    console.log(
      "[sync]",
      "Going to create conflicting copy",
      revisionFileName,
    );

    // Copy secondary to conflict copy
    const localConflictMeta = await primary.writeFile(
      revisionFileName,
      pageData2.data,
    );
    const remoteConflictMeta = await secondary.writeFile(
      revisionFileName,
      pageData2.data,
    );

    // Updating snapshot
    snapshot.set(revisionFileName, [
      localConflictMeta.lastModified,
      remoteConflictMeta.lastModified,
    ]);

    // Write replacement on top
    const writeMeta = await secondary.writeFile(
      name,
      pageData1.data,
      true,
    );

    snapshot.set(name, [pageData1.meta.lastModified, writeMeta.lastModified]);
    return 1;
  }

  syncCandidates(files: FileMeta[]): FileMeta[] {
    if (this.options.isSyncCandidate) {
      return files.filter((meta) => this.options.isSyncCandidate!(meta.name));
    } else {
      return files;
    }
  }
}

const markdownLanguage = buildMarkdown([]);

export function removeDirectiveBody(text: string): string {
  // Parse
  const tree = parse(markdownLanguage, text);
  // Remove bodies
  replaceNodesMatching(tree, (node) => {
    if (node.type === "DirectiveBody") {
      return null;
    }
  });
  // Turn back into text
  return renderToText(tree);
}
