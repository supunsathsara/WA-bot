-- Revoke anonymous access previously granted in the initial schema
DROP POLICY IF EXISTS "Allow anonymous inserts" ON public.message_logs;
DROP POLICY IF EXISTS "Allow anonymous inserts" ON public.error_logs;

-- With RLS enabled, omitting policies defaults to a "deny all" for public/anon roles.
-- The Service Role Key (which our backend uses) inherently bypasses RLS and can completely ignore these restrictions.
-- This ensures that only our backend node process can insert data into these tables, preventing public spam/abuse.
