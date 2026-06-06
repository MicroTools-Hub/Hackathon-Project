const DEFAULT_SCORE = 70;

export function ensureRating(client) {
  client.rating_score = clamp(Number(client.rating_score ?? DEFAULT_SCORE), 0, 100);
  client.rating = ratingFromScore(client.rating_score);
  client.payment_before_due_streak = Number(client.payment_before_due_streak || 0);
  return client;
}

export function recalculateRating(client, event = {}) {
  ensureRating(client);
  const previousRating = client.rating;
  const previousScore = client.rating_score;
  let delta = 0;

  if (event.type === "goods") {
    if (isSameMonth(event.recorded_at || Date.now(), Date.now())) delta += 3;
    if (event.previous_cycle_fully_unpaid) delta -= 5;
  } else if (event.type === "payment") {
    if (event.before_due_date) {
      delta += 10;
      client.payment_before_due_streak += 1;
      if (client.payment_before_due_streak >= 2) delta += 5;
    } else {
      client.payment_before_due_streak = 0;
    }
    if (event.cleared_full_balance) delta += 5;
  } else if (event.type === "reminder_paid") {
    delta -= 10;
  } else if (event.type === "overdue_no_payment") {
    delta -= 15;
    client.payment_before_due_streak = 0;
  } else if (event.type === "no_response_to_reminder") {
    delta -= 20;
    client.payment_before_due_streak = 0;
  }

  client.rating_score = clamp(previousScore + delta, 0, 100);
  client.rating = ratingFromScore(client.rating_score);
  return {
    previous_rating: previousRating,
    previous_score: previousScore,
    rating: client.rating,
    rating_score: client.rating_score,
    delta,
    dropped_to_risky: previousRating !== "risky" && client.rating === "risky"
  };
}

export function ratingFromScore(score) {
  const value = clamp(Number(score || 0), 0, 100);
  if (value >= 85) return "excellent";
  if (value >= 70) return "good";
  if (value >= 50) return "average";
  if (value >= 30) return "poor";
  return "risky";
}

function isSameMonth(left, right) {
  const a = new Date(left);
  const b = new Date(right);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
