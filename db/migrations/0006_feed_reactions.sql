CREATE TABLE "feed_reactions" (
	"feed_item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" varchar(10) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "feed_reactions_feed_item_id_user_id_pk" PRIMARY KEY("feed_item_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "feed_reactions" ADD CONSTRAINT "feed_reactions_feed_item_id_feed_items_id_fk" FOREIGN KEY ("feed_item_id") REFERENCES "public"."feed_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_reactions" ADD CONSTRAINT "feed_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_feed_reactions_user_id" ON "feed_reactions" USING btree ("user_id");
--> statement-breakpoint
-- Carry existing reactions over from the JSONB array: one per person, latest wins,
-- skipping anyone whose account no longer exists.
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
-- Recount from the rows, so the stored count and the table agree.
UPDATE "feed_items" fi
SET "reaction_count" = (SELECT count(*) FROM "feed_reactions" r WHERE r.feed_item_id = fi.id);
--> statement-breakpoint
ALTER TABLE "feed_reactions" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
