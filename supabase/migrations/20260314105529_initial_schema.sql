-- Supabase Migration Script
-- Run this in the Supabase SQL Editor to create the necessary tables for the WhatsApp Bot.

-- Create table for incoming message logs
CREATE TABLE IF NOT EXISTS public.message_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    phone_number_id TEXT NOT NULL,
    sender_number TEXT NOT NULL,
    message_id TEXT UNIQUE NOT NULL,
    message_type TEXT NOT NULL,
    content TEXT
);

-- Create table for error logs
CREATE TABLE IF NOT EXISTS public.error_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    error_message TEXT NOT NULL,
    context JSONB
);

-- Set up Row Level Security (RLS)
-- Both tables should only be writable by the backend Service Role Key.
-- No public read access is needed.

ALTER TABLE public.message_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;

-- Allow insert access for service_role or authenticated users
-- Using the service_role key bypasses RLS, but if you want to use the anon key (PUBLISH_KEY), we need to allow inserts:

CREATE POLICY "Allow anonymous inserts"
ON public.message_logs
FOR INSERT
TO anon
WITH CHECK (true);

CREATE POLICY "Allow anonymous inserts"
ON public.error_logs
FOR INSERT
TO anon
WITH CHECK (true);

-- We only allow inserts, not reads, to protect user data from the browser.
