# HANDOFF — InfinityCore/SARA audit & Zoho & signature work

## Phases done
- Phase 0: board_member SQL fix; notify/toUserMessage; category dedupe; requester labels; Zoho toggle; assign/edit responsible persons.
- Phase 3: cycle data model migration.
- Phase 5: on_time/days_late columns + trigger + RespondModal.
- Phase 4: sweep edge function skeleton + migration.
- Phase 6: email reply ingestion edge functions + migration (merged from agent).
- Phase 7: review UI merged from agent.
- Shared SignatureInput component (draw/upload).
- Build passes.

## Remaining
- Phase 4 full send pipeline (Zoho send, throttle, retry, daily cap, preview dialog, pg_cron).
- Phase 6 full ingestion (sanitise, attachments, unmatched queue).
- Phase 7 full review actions (request more info, mark person/dept/cycle, rollover).
- Phase 8 kanban cycle columns.
- Phase 2 board member tracking window (server-side RLS).
- Phase 9 per-user mailbox.
- Guarantor upload route + leave approval signature integration + final PDF generation.

## Exact next step
Deep implementation per plan; apply migrations; deploy edge functions; configure pg_cron and Storage buckets.

## Unverified
- All runtime behavior; DB migrations not applied.
