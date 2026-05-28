export type MeetingTemplate = 'general' | 'standup' | '1on1' | 'interview'

export interface MeetingRecord {
  id: string
  title: string
  startedAt: string
  endedAt: string | null
  durationSeconds: number | null
  detectedApp: string | null
  detectedAppBundleId: string | null
  template: MeetingTemplate
  createdAt: string
}

export interface TranscriptSegmentRecord {
  id: string
  meetingId: string
  speaker: string
  speakerLabel: string | null
  text: string
  startTimeMs: number
  endTimeMs: number
  isMe: boolean
}

export interface MeetingNotesRecord {
  id: string
  meetingId: string
  summary: string | null
  actionItems: unknown[]
  keyDecisions: unknown[]
  keyQuotes: unknown[]
  rawLlmOutput: string | null
  templateUsed: string | null
  createdAt: string
}

export interface MeetingDetail {
  meeting: MeetingRecord
  transcript: TranscriptSegmentRecord[]
  notes: MeetingNotesRecord | null
}

export interface MeetingListItem extends MeetingRecord {
  transcriptSegmentCount: number
  speakerCount: number
  hasNotes: boolean
}

export interface MeetingSearchResult extends MeetingListItem {
  rank: number
  matchType: 'transcript' | 'notes'
  snippet: string
}

export interface CreateMeetingInput {
  title?: string | null
  startedAt?: string
  detectedApp?: string | null
  detectedAppBundleId?: string | null
  template?: MeetingTemplate
}

export interface AddTranscriptSegmentInput {
  id?: string
  speaker?: string
  speakerLabel?: string | null
  text: string
  startTimeMs: number
  endTimeMs: number
  isMe: boolean
}

export interface SaveMeetingNotesInput {
  summary?: string | null
  actionItems?: unknown[]
  keyDecisions?: unknown[]
  keyQuotes?: unknown[]
  rawLlmOutput?: string | null
  templateUsed?: string | null
}

export interface ListMeetingsOptions {
  limit?: number
  offset?: number
}
