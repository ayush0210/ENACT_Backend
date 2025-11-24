-- Migration script to update database schema for new data structure
-- This script should be run on the production database

-- Step 1: Add caregiver_type column to users table
ALTER TABLE users
ADD COLUMN caregiver_type VARCHAR(50) DEFAULT NULL
COMMENT 'Type of caregiver: parent, grandparent, guardian, nanny, other_family, other';

-- Step 2: Add age column to children table
ALTER TABLE children
ADD COLUMN age INT DEFAULT NULL
COMMENT 'Age of child (1-5)';

-- Step 3: Migrate existing date_of_birth data to age
-- Calculate age from date_of_birth and populate the new age column
UPDATE children
SET age = TIMESTAMPDIFF(YEAR, date_of_birth, CURDATE())
WHERE date_of_birth IS NOT NULL;

-- Step 4: Add constraint to ensure age is between 1 and 5
ALTER TABLE children
ADD CONSTRAINT chk_age CHECK (age >= 1 AND age <= 5);

-- Step 5: Make age column NOT NULL after data migration
ALTER TABLE children
MODIFY COLUMN age INT NOT NULL;

-- Step 6: Drop the old date_of_birth column (OPTIONAL - only after verifying migration)
-- IMPORTANT: Only run this after confirming the migration is successful
-- ALTER TABLE children DROP COLUMN date_of_birth;

-- Verification queries (run these to check the migration)
-- SELECT COUNT(*) FROM children WHERE age IS NULL;
-- SELECT age, COUNT(*) as count FROM children GROUP BY age ORDER BY age;
-- SELECT * FROM users LIMIT 10;
