-- Review fix: at most one open online checkout per pay link (two tabs can't both pay the same balance).
UPDATE online_checkout c SET status = 'canceled', completed_at = now()
 WHERE status = 'open' AND EXISTS (SELECT 1 FROM online_checkout d WHERE d.link_id = c.link_id AND d.status = 'open' AND d.created_at > c.created_at);
CREATE UNIQUE INDEX online_checkout_one_open ON online_checkout (link_id) WHERE status = 'open';
