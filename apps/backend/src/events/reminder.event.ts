import { notifyToWebUsers } from '../lib/buzzer'
import { delCache, getJSONCache, redis } from '../lib/redis'
import TaskReminderJob from '../jobs/reminder.job'
import { mdUserFindEmailsByUids } from '@database'
import { sendEmail } from '../lib/email'

type RemindPayload = {
  message: string
  link: string
  receivers: string[]
}

const LOG_TAG = '[reminder.event]'

export class ReminderEvent {
  taskReminderJob: TaskReminderJob
  constructor() {
    this.taskReminderJob = new TaskReminderJob()
  }
  async run() {
    try {
      const now = new Date()

      const results = await this.taskReminderJob.findByTime(now)

      if (!results.length) return

      // Use for...of to properly await each iteration (forEach+async swallows errors)
      for (const k of results) {
        try {
          // Atomic dedup: try to set a "sent" marker key with SET NX and 10min TTL.
          // If the key already exists, this reminder was already processed — skip it.
          const dedupKey = `sent:${k}`
          const acquired = await redis.set(dedupKey, '1', 'EX', 600, 'NX')

          if (!acquired) {
            console.log(
              `${LOG_TAG} [dedup-skip] reminder already sent, key=${k}`
            )
            continue
          }

          const data = await getJSONCache([k])
          if (!data) {
            // Key expired between findByTime and getJSONCache — safe to clean up
            await redis.del(dedupKey)
            continue
          }

          const payload = data as RemindPayload
          await this.sendNotification(payload)
          await this.sendEmailReminder(payload)

          // Delete the original reminder key immediately after successful delivery
          // so subsequent cron ticks within the TTL window won't pick it up again.
          await delCache([k])

          console.log(
            `${LOG_TAG} [delivered] taskId=${this._extractTaskId(k)}, receivers=${payload.receivers?.length || 0}`
          )
        } catch (err) {
          // If delivery failed, remove the dedup marker so a retry can pick it up.
          const dedupKey = `sent:${k}`
          await redis.del(dedupKey)
          console.error(
            `${LOG_TAG} [delivery-error] key=${k}`,
            err instanceof Error ? err.message : err
          )
        }
      }
    } catch (error) {
      console.error(
        `${LOG_TAG} [run-error]`,
        error instanceof Error ? error.message : error
      )
    }
  }

  /**
   * Extract taskId from a reminder Redis key like "remind-20240614-12:30-task-<taskId>"
   */
  private _extractTaskId(key: string): string {
    const match = key.match(/task-(.+)$/)
    return match ? match[1] : 'unknown'
  }

  async sendNotification(data: RemindPayload) {
    const { receivers, message, link } = data
    if (!receivers || !receivers.length) return

    const receiverSets = new Set(receivers)
    const filteredReceivers = Array.from(receiverSets)

    await notifyToWebUsers(filteredReceivers, {
      title: 'Reminder ⏰',
      body: message,
      deep_link: link
    })
  }

  async sendEmailReminder(data: RemindPayload) {
    const { receivers, message, link } = data
    if (!receivers || !receivers.length) return

    const emails = await mdUserFindEmailsByUids(receivers)

    if (!emails.length) return

    await sendEmail({
      emails,
      subject: 'Reminder ⏰',
      html: `
${message}
Link: ${link}
`
    })
  }
}
