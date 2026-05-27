import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateDatabase, openDatabase, type SqliteDatabase } from './database'
import { MeetingStore } from './meeting-store'

describe('MeetingStore', () => {
  let tempDir: string
  let db: SqliteDatabase
  let store: MeetingStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cereal-storage-'))
    db = openDatabase(join(tempDir, 'data.sqlite'))
    store = new MeetingStore(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates the initial schema and can migrate idempotently', () => {
    migrateDatabase(db)

    const names = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type IN ('table', 'trigger')
         ORDER BY name`
      )
      .pluck()
      .all()

    expect(names).toEqual(
      expect.arrayContaining([
        'meetings',
        'transcript_segments',
        'meeting_notes',
        'transcript_fts',
        'notes_fts',
        'transcript_ai',
        'transcript_ad',
        'transcript_au',
        'notes_ai',
        'notes_ad',
        'notes_au'
      ])
    )
    expect(db.pragma('user_version', { simple: true })).toBe(1)
  })

  it('creates, lists, finishes, and loads a meeting', () => {
    const id = store.createMeeting({
      title: 'Weekly Sync',
      startedAt: '2026-05-27T14:00:00.000Z',
      detectedApp: 'Zoom',
      detectedAppBundleId: 'us.zoom.xos',
      template: 'standup'
    })

    const finished = store.finishMeeting(id, '2026-05-27T14:15:30.000Z')
    const detail = store.getMeeting(id)
    const list = store.listMeetings()

    expect(finished?.durationSeconds).toBe(930)
    expect(detail?.meeting).toMatchObject({
      id,
      title: 'Weekly Sync',
      detectedApp: 'Zoom',
      detectedAppBundleId: 'us.zoom.xos',
      template: 'standup'
    })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id,
      transcriptSegmentCount: 0,
      speakerCount: 0,
      hasNotes: false
    })
  })

  it('inserts transcript segments singly and in batches', () => {
    const meetingId = store.createMeeting({ title: 'Design Review' })

    const micSegmentId = store.addTranscriptSegment(meetingId, {
      text: 'I will update the prototype.',
      startTimeMs: 0,
      endTimeMs: 1400,
      isMe: true
    })
    const batchIds = store.addTranscriptSegmentsBatch(meetingId, [
      {
        text: 'The roadmap needs a launch checkpoint.',
        startTimeMs: 1500,
        endTimeMs: 3200,
        isMe: false
      },
      {
        speaker: 'speaker-1',
        text: 'I can own the customer follow-up.',
        startTimeMs: 3300,
        endTimeMs: 4600,
        isMe: false
      }
    ])

    const detail = store.getMeeting(meetingId)

    expect(micSegmentId).toEqual(expect.any(String))
    expect(batchIds).toHaveLength(2)
    expect(detail?.transcript.map((segment) => segment.speaker)).toEqual([
      'me',
      'others',
      'speaker-1'
    ])
    expect(detail?.transcript.map((segment) => segment.isMe)).toEqual([true, false, false])
    expect(store.listMeetings()[0]).toMatchObject({
      transcriptSegmentCount: 3,
      speakerCount: 3
    })
  })

  it('saves and updates meeting notes', () => {
    const meetingId = store.createMeeting({ title: 'Planning' })

    const first = store.saveMeetingNotes(meetingId, {
      summary: '- Initial summary',
      actionItems: [{ text: 'Draft the plan', assignee: 'Beau' }],
      keyDecisions: [{ text: 'Use SQLite locally' }],
      keyQuotes: [{ text: 'Keep it local', speaker: 'me', timestamp_ms: 10 }],
      rawLlmOutput: '{"summary":"Initial summary"}',
      templateUsed: 'general'
    })
    const second = store.saveMeetingNotes(meetingId, {
      summary: '- Updated summary with phoenix launch details',
      actionItems: [{ text: 'Review the launch checklist' }],
      templateUsed: 'standup'
    })

    expect(second.id).toBe(first.id)
    expect(second.summary).toContain('phoenix')
    expect(second.actionItems).toEqual([{ text: 'Review the launch checklist' }])
    expect(second.keyDecisions).toEqual([])
    expect(store.getMeeting(meetingId)?.notes).toMatchObject({
      id: first.id,
      templateUsed: 'standup'
    })
    expect(store.listMeetings()[0].hasNotes).toBe(true)
    expect(store.searchMeetings('Initial')).toHaveLength(0)
    expect(store.searchMeetings('phoenix')).toHaveLength(1)
  })

  it('searches transcript and notes full text', () => {
    const transcriptMeetingId = store.createMeeting({ title: 'Transcript Match' })
    const notesMeetingId = store.createMeeting({ title: 'Notes Match' })

    store.addTranscriptSegment(transcriptMeetingId, {
      text: 'The roadmap needs a launch checkpoint.',
      startTimeMs: 0,
      endTimeMs: 1000,
      isMe: false
    })
    store.saveMeetingNotes(notesMeetingId, {
      summary: 'Budget owners agreed to the phoenix rollout.',
      actionItems: [{ text: 'Confirm phoenix staffing' }]
    })

    const transcriptResults = store.searchMeetings('roadmap')
    const notesResults = store.searchMeetings('phoenix')

    expect(transcriptResults).toHaveLength(1)
    expect(transcriptResults[0]).toMatchObject({
      id: transcriptMeetingId,
      matchType: 'transcript'
    })
    expect(notesResults).toHaveLength(1)
    expect(notesResults[0]).toMatchObject({
      id: notesMeetingId,
      matchType: 'notes'
    })
  })

  it('updates speaker labels for every matching speaker in a meeting', () => {
    const meetingId = store.createMeeting({ title: 'Interview' })
    store.addTranscriptSegmentsBatch(meetingId, [
      {
        speaker: 'speaker-1',
        text: 'First answer.',
        startTimeMs: 0,
        endTimeMs: 500,
        isMe: false
      },
      {
        speaker: 'speaker-1',
        text: 'Second answer.',
        startTimeMs: 600,
        endTimeMs: 1200,
        isMe: false
      },
      {
        speaker: 'speaker-2',
        text: 'Different speaker.',
        startTimeMs: 1300,
        endTimeMs: 1700,
        isMe: false
      }
    ])

    const changed = store.updateSpeakerLabel(meetingId, 'speaker-1', 'Greg')
    const labels = store.getMeeting(meetingId)?.transcript.map((segment) => segment.speakerLabel)

    expect(changed).toBe(2)
    expect(labels).toEqual(['Greg', 'Greg', null])
  })

  it('deletes a meeting and cascades related transcript and notes rows', () => {
    const meetingId = store.createMeeting({ title: 'Delete Me' })
    store.addTranscriptSegment(meetingId, {
      text: 'Temporary transcript.',
      startTimeMs: 0,
      endTimeMs: 1000,
      isMe: true
    })
    store.saveMeetingNotes(meetingId, {
      summary: 'Temporary summary.'
    })

    expect(store.searchMeetings('Temporary')).toHaveLength(1)
    expect(store.deleteMeeting(meetingId)).toBe(true)
    expect(store.getMeeting(meetingId)).toBeNull()
    expect(store.searchMeetings('Temporary')).toHaveLength(0)
    expect(
      db.prepare('SELECT COUNT(*) FROM transcript_segments WHERE meeting_id = ?').pluck().get(meetingId)
    ).toBe(0)
    expect(db.prepare('SELECT COUNT(*) FROM meeting_notes WHERE meeting_id = ?').pluck().get(meetingId)).toBe(0)
  })
})
