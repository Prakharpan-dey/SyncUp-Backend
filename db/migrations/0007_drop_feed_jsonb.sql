-- Apply only after a backend release WITHOUT these columns in its schema is
-- live: the older build reads them (select-all and returning-all queries).
--
-- First, catch any reaction written to the old JSONB array after 0006 copied
-- them (the window between that migration and the deploy), then recount.
INSERT INTO "feed_reactions" ("feed_item_id", "user_id", "emoji", "created_at")
SELECT DISTINCT ON (fi.id, (e->>'user_id')::uuid)
       fi.id, (e->>'user_id')::uuid, left(e->>'emoji', 10),
       COALESCE((e->>'created_at')::timestamp, now())
FROM "feed_items" fi
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fi.reactions, '[]'::jsonb)) e
WHERE e->>'user_id' IS NOT NULL AND e->>'emoji' IS NOT NULL
  AND EXISTS (SELECT 1 FROM "users" u WHERE u.id = (e->>'user_id')::uuid)
ORDER BY fi.id, (e->>'user_id')::uuid, e->>'created_at' DESC
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "feed_items" fi
SET "reaction_count" = (SELECT count(*) FROM "feed_reactions" r WHERE r.feed_item_id = fi.id);
--> statement-breakpoint
ALTER TABLE "feed_items" DROP COLUMN "comment_count";--> statement-breakpoint
ALTER TABLE "feed_items" DROP COLUMN "reactions";--> statement-breakpoint
ALTER TABLE "feed_items" DROP COLUMN "comments";