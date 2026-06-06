import cron from "node-cron";
import { store } from "../store/memory.js";
import { sseManager } from "../sse/manager.js";
import { sendReminder } from "../whatsapp/sender.js";
import { logger } from "../utils/logger.js";

export function scheduleDailyReminders() {
  return cron.schedule("0 9 * * *", () => {
    runDailyReminderCheck().catch((error) => {
      logger.error("Daily reminder job failed", { error: error.message });
      sseManager.error({ message: error.message, source: "daily_reminders" });
    });
  });
}

export async function runDailyReminderCheck() {
  const dueClients = store.getDueClients({ overdueOnly: true });
  const results = [];

  for (const client of dueClients) {
    const overdueRating = shouldApplyOverduePenalty(client)
      ? store.markOverdueNoPayment(client.id)
      : null;

    if (overdueRating?.rating?.dropped_to_risky) {
      sseManager.ratingAlert({
        client_id: client.id,
        client_name: client.name,
        rating: client.rating,
        rating_score: client.rating_score
      });
    }

    let delivery = { skipped: true, reason: "not_sent" };
    try {
      delivery = await sendReminder(client.phone, {
        client_name: client.name,
        amount: client.running_balance,
        business_name: store.getBusiness().name,
        due_date: new Date(client.due_date).toLocaleDateString("en-IN")
      });
      store.markReminderSent(client.id);
    } catch (error) {
      delivery = { skipped: true, reason: error.message };
    }

    const payload = {
      client_id: client.id,
      client_name: client.name,
      phone: client.phone,
      amount: client.running_balance,
      due_date: client.due_date,
      delivery
    };
    sseManager.reminder(payload);
    results.push(payload);
  }

  const event = store.addConnectionEvent("cron", `Daily reminder check completed for ${results.length} clients`);
  sseManager.connection({ status: "cron", message: event.message, at: event.at });
  return results;
}

function shouldApplyOverduePenalty(client) {
  if (!client.due_date || client.running_balance <= 0 || client.due_date >= Date.now()) return false;
  if (!client.last_overdue_rating_at) return true;
  return new Date(client.last_overdue_rating_at).toDateString() !== new Date().toDateString();
}
