-- Migration script to add action and about_references columns to note tables
-- Run this script directly in your PostgreSQL database if the automatic migration fails

-- Hiring Manager Notes
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='hiring_manager_notes' AND column_name='action'
    ) THEN
        ALTER TABLE hiring_manager_notes ADD COLUMN action VARCHAR(255);
        RAISE NOTICE 'Added action column to hiring_manager_notes';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='hiring_manager_notes' AND column_name='about_references'
    ) THEN
        ALTER TABLE hiring_manager_notes ADD COLUMN about_references JSONB;
        RAISE NOTICE 'Added about_references column to hiring_manager_notes';
    END IF;
END $$;

-- Job Seeker Notes
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='job_seeker_notes' AND column_name='action'
    ) THEN
        ALTER TABLE job_seeker_notes ADD COLUMN action VARCHAR(255);
        RAISE NOTICE 'Added action column to job_seeker_notes';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='job_seeker_notes' AND column_name='about_references'
    ) THEN
        ALTER TABLE job_seeker_notes ADD COLUMN about_references JSONB;
        RAISE NOTICE 'Added about_references column to job_seeker_notes';
    END IF;
END $$;

-- Lead Notes
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='lead_notes' AND column_name='action'
    ) THEN
        ALTER TABLE lead_notes ADD COLUMN action VARCHAR(255);
        RAISE NOTICE 'Added action column to lead_notes';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='lead_notes' AND column_name='about_references'
    ) THEN
        ALTER TABLE lead_notes ADD COLUMN about_references JSONB;
        RAISE NOTICE 'Added about_references column to lead_notes';
    END IF;
END $$;

-- Job Notes
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='job_notes' AND column_name='action'
    ) THEN
        ALTER TABLE job_notes ADD COLUMN action VARCHAR(255);
        RAISE NOTICE 'Added action column to job_notes';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='job_notes' AND column_name='about_references'
    ) THEN
        ALTER TABLE job_notes ADD COLUMN about_references JSONB;
        RAISE NOTICE 'Added about_references column to job_notes';
    END IF;
END $$;

-- Task Notes
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='task_notes' AND column_name='action'
    ) THEN
        ALTER TABLE task_notes ADD COLUMN action VARCHAR(255);
        RAISE NOTICE 'Added action column to task_notes';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema='public' AND table_name='task_notes' AND column_name='about_references'
    ) THEN
        ALTER TABLE task_notes ADD COLUMN about_references JSONB;
        RAISE NOTICE 'Added about_references column to task_notes';
    END IF;
END $$;
