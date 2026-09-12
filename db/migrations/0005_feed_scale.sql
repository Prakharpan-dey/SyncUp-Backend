-- The table is tiny today, so plain CREATE INDEX is instant. At scale, any
-- index change on feed_items must be a hand-written CREATE INDEX CONCURRENTLY
-- run outside drizzle's migration transaction.
DROP INDEX "idx_feed_items_user_id";--> statement-breakpoint
CREATE INDEX "idx_feed_items_user_created" ON "feed_items" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_feed_items_group_created" ON "feed_items" USING btree ("group_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "feed_items"."group_id" IS NOT NULL;
--> statement-breakpoint
-- feed_items churns (posts in and out daily under retention): vacuum and
-- re-plan it far more often than the defaults would.
ALTER TABLE "feed_items" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
