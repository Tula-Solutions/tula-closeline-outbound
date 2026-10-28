import type { OrganizationId, Play, PlayId, PlayIntent } from 'tula-closeline-contract'

/** Which stored Plays a list may return; every field narrows. */
export type PlayFilter = {
  status?: Play['status'] | undefined
  intent?: PlayIntent | undefined
  source?: Play['source'] | undefined
}

/** Where a newest-first page resumes: after the Play with this creation time and id. */
export type PlayPosition = { createdAt: string; id: PlayId }

/** One page of Plays, newest first; `next` is set when more follow. */
export type PlayPage = { items: Play[]; next: PlayPosition | null }

/** The store of Plays and their citations; every call is scoped to one Organization. Built-in Plays are never stored. */
export type PlayStore = {
  /** Writes the Play unless one with that id exists; returns what is stored and whether it was written now. */
  insertIfAbsent: (
    organizationId: OrganizationId,
    play: Play
  ) => Promise<{ play: Play; created: boolean }>
  /** The Play, or null when the Organization has none with this id. */
  find: (organizationId: OrganizationId, id: PlayId) => Promise<Play | null>
  /** A newest-first page of at most `limit` Plays, resuming after `after`. */
  list: (
    organizationId: OrganizationId,
    filter: PlayFilter,
    after: PlayPosition | null,
    limit: number
  ) => Promise<PlayPage>
  /**
   * Applies `change` to the Play under a lock and stores the result; a throw from `change` writes
   * nothing. Null when the Organization has no such Play.
   */
  modify: (
    organizationId: OrganizationId,
    id: PlayId,
    change: (play: Play) => Play
  ) => Promise<Play | null>
}
