# Refunds suspend Enrollments and keep progress

When a Refund Request is approved, the learner's Enrollment is suspended, not deleted. Their progress (lesson completions, watch history, quiz attempts, comments, and their course rating, which stops counting toward the average) is kept forever. Getting the course again by any route, whether buying it or claiming a Team Seat, resumes the same Enrollment. Access to content was always gated by the Enrollment and never by progress, so keeping the progress gives away nothing a refund paid for. Deleting it would be irreversible, would throw away watch history that is our evidence if a chargeback is disputed, and would punish a learner who comes back.

## Considered Options

- **Delete the Enrollment and progress on approval**: rejected because it can't be undone, and the data has no cash value to protect.
- **Keep progress for N days, then purge**: rejected because it adds a scheduled job and a retention policy to maintain, for no money-related benefit.

## Consequences

- Anything that counts learners, ratings or revenue for a course must leave out Suspended Enrollments and refunded purchases. Rows still existing doesn't mean they count.
- A refunded purchase leaves instructor revenue at approval, not when the money is confirmed as sent.
