-- Table to track which phone numbers are allowed to use the bot
CREATE TABLE IF NOT EXISTS public.allowed_numbers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number TEXT UNIQUE NOT NULL,
    added_by TEXT,  -- Who added this number (admin's number or 'env')
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS — only the service role key can manage this table
ALTER TABLE public.allowed_numbers ENABLE ROW LEVEL SECURITY;

-- No public access — only backend (service role) can read/write
