import { randomUUID } from 'crypto'
import { getDatabase, type SqliteDatabase } from './database'
import type {
  AddTranscriptSegmentInput,
  CreateMeetingInput,
  ListMeetingsOptions,
  MeetingDetail,
  MeetingListItem,
  MeetingNotesRecord,
  MeetingRecord,
  MeetingSearchResult,
  MeetingTemplate,
  SaveMeetingNotesInput,
  TranscriptSegmentRecord
} from '../shared/meeting-types'

interface MeetingRow {
  id: string
  title: string
  started_at: string
  ended_at: string | null
  duration_seconds: number | null
  detected_app: string | null
  detected_app_bundle_id: string | null
  template: MeetingTemplate
  created_at: string
}

interface TranscriptSegmentRow {
  id: string
  meeting_id: string
  speaker: string
  speaker_label: string | null
  text: string
  start_time_ms: number
  end_time_ms: number
  is_me: number
}

interface MeetingNotesRow {
  id: string
  meeting_id: string
  summary: string | null
  action_items: string
  key_decisions: string
  key_quotes: string
  raw_llm_output: string | null
  template_used: string | null
  created_at: string
}

interface MeetingListRow extends MeetingRow {
  transcript_segment_count: number
  speaker_count: number
  has_notes: number
}

interface MeetingSearchRow extends MeetingListRow {
  rank: number
  match_type: 'transcript' | 'notes'
  snippet: string
}

const DEFAULT_MEETING_TITLE = 'Untitled Meeting'
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200

export class MeetingStore {
  constructor(private readonly db: SqliteDatabase) {}

  createMeeting(input: CreateMeetingInput = {}): string {
    const id = randomUUID()
    const now = new Date().toISOString()
    const startedAt = input.startedAt ?? now
    const title = normalizeTitle(input.title)

    this.db
      .prepare(
        `INSERT INTO meetings (
          id, title, started_at, detected_app, detected_app_bundle_id, template, created_at
        ) VALUES (
          @id, @title, @startedAt, @detectedApp, @detectedAppBundleId, @template, @createdAt
        )`
      )
      .run({
        id,
        title,
        startedAt,
        detectedApp: input.detectedApp ?? null,
        detectedAppBundleId: input.detectedAppBundleId ?? null,
        template: input.template ?? 'general',
        createdAt: now
      })

    return id
  }

  finishMeeting(id: string, endedAt = new Date().toISOString()): MeetingRecord | null {
    const meeting = this.getMeetingRecord(id)
    if (!meeting) {
      return null
    }

    this.db
      .prepare(
        `UPDATE meetings
         SET ended_at = @endedAt,
             duration_seconds = @durationSeconds
         WHERE id = @id`
      )
      .run({
        id,
        endedAt,
        durationSeconds: calculateDurationSeconds(meeting.startedAt, endedAt)
      })

    return this.getMeetingRecord(id)
  }

  addTranscriptSegment(meetingId: string, input: AddTranscriptSegmentInput): string {
    const id = input.id ?? randomUUID()
    this.insertTranscriptSegment(meetingId, id, input)
    return id
  }

  addTranscriptSegmentsBatch(meetingId: string, inputs: AddTranscriptSegmentInput[]): string[] {
    const rows = inputs.map((input) => ({
      id: input.id ?? randomUUID(),
      input
    }))

    const insertMany = this.db.transaction(() => {
      for (const row of rows) {
        this.insertTranscriptSegment(meetingId, row.id, row.input)
      }
    })
    insertMany()

    return rows.map((row) => row.id)
  }

  saveMeetingNotes(meetingId: string, input: SaveMeetingNotesInput): MeetingNotesRecord {
    const existing = this.getMeetingNotesRecord(meetingId)
    const id = existing?.id ?? randomUUID()
    const createdAt = existing?.createdAt ?? new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO meeting_notes (
          id, meeting_id, summary, action_items, key_decisions, key_quotes,
          raw_llm_output, template_used, created_at
        ) VALUES (
          @id, @meetingId, @summary, @actionItems, @keyDecisions, @keyQuotes,
          @rawLlmOutput, @templateUsed, @createdAt
        )
        ON CONFLICT(meeting_id) DO UPDATE SET
          summary = excluded.summary,
          action_items = excluded.action_items,
          key_decisions = excluded.key_decisions,
          key_quotes = excluded.key_quotes,
          raw_llm_output = excluded.raw_llm_output,
          template_used = excluded.template_used`
      )
      .run({
        id,
        meetingId,
        summary: input.summary ?? null,
        actionItems: serializeJsonArray(input.actionItems),
        keyDecisions: serializeJsonArray(input.keyDecisions),
        keyQuotes: serializeJsonArray(input.keyQuotes),
        rawLlmOutput: input.rawLlmOutput ?? null,
        templateUsed: input.templateUsed ?? null,
        createdAt
      })

    const notes = this.getMeetingNotesRecord(meetingId)
    if (!notes) {
      throw new Error(`Failed to save notes for meeting ${meetingId}`)
    }

    return notes
  }

  getMeeting(id: string): MeetingDetail | null {
    const meeting = this.getMeetingRecord(id)
    if (!meeting) {
      return null
    }

    const transcript = this.db
      .prepare(
        `SELECT *
         FROM transcript_segments
         WHERE meeting_id = ?
         ORDER BY start_time_ms ASC, end_time_ms ASC, id ASC`
      )
      .all(id)
      .map((row) => mapTranscriptSegmentRow(row as TranscriptSegmentRow))

    return {
      meeting,
      transcript,
      notes: this.getMeetingNotesRecord(id)
    }
  }

  listMeetings(options: ListMeetingsOptions = {}): MeetingListItem[] {
    const { limit, offset } = normalizeListOptions(options)
    return this.db
      .prepare(MEETING_LIST_SQL)
      .all({ limit, offset })
      .map((row) => mapMeetingListRow(row as MeetingListRow))
  }

  searchMeetings(query: string, options: ListMeetingsOptions = {}): MeetingSearchResult[] {
    const ftsQuery = buildFtsQuery(query)
    if (!ftsQuery) {
      return []
    }

    const { limit, offset } = normalizeListOptions(options)
    return this.db
      .prepare(MEETING_SEARCH_SQL)
      .all({ query: ftsQuery, limit, offset })
      .map((row) => mapMeetingSearchRow(row as MeetingSearchRow))
  }

  updateMeetingTitle(id: string, title: string): MeetingRecord | null {
    this.db
      .prepare('UPDATE meetings SET title = @title WHERE id = @id')
      .run({ id, title: normalizeTitle(title) })

    return this.getMeetingRecord(id)
  }

  updateSpeakerLabel(meetingId: string, speaker: string, label: string | null): number {
    const normalizedLabel = label?.trim() ? label.trim() : null
    const info = this.db
      .prepare(
        `UPDATE transcript_segments
         SET speaker_label = @label
         WHERE meeting_id = @meetingId AND speaker = @speaker`
      )
      .run({ meetingId, speaker, label: normalizedLabel })

    return info.changes
  }

  deleteMeeting(id: string): boolean {
    const info = this.db.prepare('DELETE FROM meetings WHERE id = ?').run(id)
    return info.changes > 0
  }

  private insertTranscriptSegment(
    meetingId: string,
    id: string,
    input: AddTranscriptSegmentInput
  ): void {
    const speaker = input.speaker ?? (input.isMe ? 'me' : 'others')
    this.db
      .prepare(
        `INSERT INTO transcript_segments (
          id, meeting_id, speaker, speaker_label, text, start_time_ms, end_time_ms, is_me
        ) VALUES (
          @id, @meetingId, @speaker, @speakerLabel, @text, @startTimeMs, @endTimeMs, @isMe
        )`
      )
      .run({
        id,
        meetingId,
        speaker,
        speakerLabel: input.speakerLabel ?? null,
        text: input.text,
        startTimeMs: input.startTimeMs,
        endTimeMs: input.endTimeMs,
        isMe: input.isMe ? 1 : 0
      })
  }

  private getMeetingRecord(id: string): MeetingRecord | null {
    const row = this.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as
      | MeetingRow
      | undefined
    return row ? mapMeetingRow(row) : null
  }

  private getMeetingNotesRecord(meetingId: string): MeetingNotesRecord | null {
    const row = this.db.prepare('SELECT * FROM meeting_notes WHERE meeting_id = ?').get(meetingId) as
      | MeetingNotesRow
      | undefined
    return row ? mapMeetingNotesRow(row) : null
  }
}

let defaultStore: MeetingStore | null = null

export function getMeetingStore(): MeetingStore {
  if (!defaultStore) {
    defaultStore = new MeetingStore(getDatabase())
  }

  return defaultStore
}

export function createMeeting(input?: CreateMeetingInput): string {
  return getMeetingStore().createMeeting(input)
}

export function finishMeeting(id: string, endedAt?: string): MeetingRecord | null {
  return getMeetingStore().finishMeeting(id, endedAt)
}

export function addTranscriptSegment(meetingId: string, input: AddTranscriptSegmentInput): string {
  return getMeetingStore().addTranscriptSegment(meetingId, input)
}

export function addTranscriptSegmentsBatch(
  meetingId: string,
  inputs: AddTranscriptSegmentInput[]
): string[] {
  return getMeetingStore().addTranscriptSegmentsBatch(meetingId, inputs)
}

export function saveMeetingNotes(
  meetingId: string,
  input: SaveMeetingNotesInput
): MeetingNotesRecord {
  return getMeetingStore().saveMeetingNotes(meetingId, input)
}

export function getMeeting(id: string): MeetingDetail | null {
  return getMeetingStore().getMeeting(id)
}

export function listMeetings(options?: ListMeetingsOptions): MeetingListItem[] {
  return getMeetingStore().listMeetings(options)
}

export function searchMeetings(
  query: string,
  options?: ListMeetingsOptions
): MeetingSearchResult[] {
  return getMeetingStore().searchMeetings(query, options)
}

export function updateMeetingTitle(id: string, title: string): MeetingRecord | null {
  return getMeetingStore().updateMeetingTitle(id, title)
}

export function updateSpeakerLabel(
  meetingId: string,
  speaker: string,
  label: string | null
): number {
  return getMeetingStore().updateSpeakerLabel(meetingId, speaker, label)
}

export function deleteMeeting(id: string): boolean {
  return getMeetingStore().deleteMeeting(id)
}

const MEETING_LIST_SQL = `
SELECT
  m.*,
  COUNT(ts.id) AS transcript_segment_count,
  COUNT(DISTINCT ts.speaker) AS speaker_count,
  CASE WHEN mn.id IS NULL THEN 0 ELSE 1 END AS has_notes
FROM meetings m
LEFT JOIN transcript_segments ts ON ts.meeting_id = m.id
LEFT JOIN meeting_notes mn ON mn.meeting_id = m.id
GROUP BY m.id
ORDER BY m.started_at DESC, m.created_at DESC
LIMIT @limit OFFSET @offset
`

const MEETING_SEARCH_SQL = `
WITH transcript_matches AS (
  SELECT
    ts.meeting_id,
    'transcript' AS match_type,
    snippet(transcript_fts, 0, '<mark>', '</mark>', '...', 12) AS snippet,
    bm25(transcript_fts) AS rank
  FROM transcript_fts
  JOIN transcript_segments ts ON ts.rowid = transcript_fts.rowid
  WHERE transcript_fts MATCH @query
),
notes_matches AS (
  SELECT
    mn.meeting_id,
    'notes' AS match_type,
    snippet(notes_fts, -1, '<mark>', '</mark>', '...', 12) AS snippet,
    bm25(notes_fts) AS rank
  FROM notes_fts
  JOIN meeting_notes mn ON mn.rowid = notes_fts.rowid
  WHERE notes_fts MATCH @query
),
all_matches AS (
  SELECT * FROM transcript_matches
  UNION ALL
  SELECT * FROM notes_matches
),
ranked_matches AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY meeting_id ORDER BY rank ASC) AS row_number
  FROM all_matches
),
meeting_stats AS (
  SELECT
    m.*,
    COUNT(ts.id) AS transcript_segment_count,
    COUNT(DISTINCT ts.speaker) AS speaker_count,
    CASE WHEN mn.id IS NULL THEN 0 ELSE 1 END AS has_notes
  FROM meetings m
  LEFT JOIN transcript_segments ts ON ts.meeting_id = m.id
  LEFT JOIN meeting_notes mn ON mn.meeting_id = m.id
  GROUP BY m.id
)
SELECT
  meeting_stats.*,
  ranked_matches.rank,
  ranked_matches.match_type,
  ranked_matches.snippet
FROM ranked_matches
JOIN meeting_stats ON meeting_stats.id = ranked_matches.meeting_id
WHERE ranked_matches.row_number = 1
ORDER BY ranked_matches.rank ASC, meeting_stats.started_at DESC
LIMIT @limit OFFSET @offset
`

function mapMeetingRow(row: MeetingRow): MeetingRecord {
  return {
    id: row.id,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    detectedApp: row.detected_app,
    detectedAppBundleId: row.detected_app_bundle_id,
    template: row.template,
    createdAt: row.created_at
  }
}

function mapTranscriptSegmentRow(row: TranscriptSegmentRow): TranscriptSegmentRecord {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    speaker: row.speaker,
    speakerLabel: row.speaker_label,
    text: row.text,
    startTimeMs: row.start_time_ms,
    endTimeMs: row.end_time_ms,
    isMe: row.is_me === 1
  }
}

function mapMeetingNotesRow(row: MeetingNotesRow): MeetingNotesRecord {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    summary: row.summary,
    actionItems: parseJsonArray(row.action_items),
    keyDecisions: parseJsonArray(row.key_decisions),
    keyQuotes: parseJsonArray(row.key_quotes),
    rawLlmOutput: row.raw_llm_output,
    templateUsed: row.template_used,
    createdAt: row.created_at
  }
}

function mapMeetingListRow(row: MeetingListRow): MeetingListItem {
  return {
    ...mapMeetingRow(row),
    transcriptSegmentCount: row.transcript_segment_count,
    speakerCount: row.speaker_count,
    hasNotes: row.has_notes === 1
  }
}

function mapMeetingSearchRow(row: MeetingSearchRow): MeetingSearchResult {
  return {
    ...mapMeetingListRow(row),
    rank: row.rank,
    matchType: row.match_type,
    snippet: row.snippet
  }
}

function normalizeTitle(value: string | null | undefined): string {
  return value?.trim() || DEFAULT_MEETING_TITLE
}

function calculateDurationSeconds(startedAt: string, endedAt: string): number | null {
  const startMs = Date.parse(startedAt)
  const endMs = Date.parse(endedAt)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null
  }

  return Math.max(0, Math.round((endMs - startMs) / 1000))
}

function normalizeListOptions(options: ListMeetingsOptions): { limit: number; offset: number } {
  const requestedLimit = options.limit ?? DEFAULT_LIST_LIMIT
  const requestedOffset = options.offset ?? 0

  return {
    limit: Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(requestedLimit))),
    offset: Math.max(0, Math.trunc(requestedOffset))
  }
}

function serializeJsonArray(value: unknown[] | undefined): string {
  return JSON.stringify(Array.isArray(value) ? value : [])
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function buildFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' ')
}
