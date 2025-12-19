-- ============================================
-- PREVENT MULTIPLE ACTIVITY TYPES PER DAY
-- ============================================
-- Rule: A user can earn Energy from only ONE activity type per day
-- Once they complete an activity of one type (walk/run/cycle), 
-- they cannot earn energy from other activity types that day.
-- This applies to both free and subscription users.
-- ============================================

-- Step 1: Update the energy points trigger to check for existing energy from other activity types
CREATE OR REPLACE FUNCTION award_energy_points_for_activity()
RETURNS TRIGGER AS $$
DECLARE
    points_earned INTEGER;
    distance_km DOUBLE PRECISION;
    daily_distance_meters DOUBLE PRECISION;
    daily_energy_earned INTEGER;
    v_activity_date DATE;
    daily_limit_meters DOUBLE PRECISION;
    daily_limit_energy INTEGER;
    energy_per_km INTEGER;
    min_energy INTEGER;
    remaining_distance_meters DOUBLE PRECISION;
    eligible_distance_meters DOUBLE PRECISION;
    current_hour INTEGER;
    reset_hour INTEGER := 22; -- 10 PM
    existing_energy_activity_type TEXT; -- Track which activity type already earned energy today
BEGIN
    -- Get current hour to determine activity date (reset at 10 PM)
    current_hour := EXTRACT(HOUR FROM CURRENT_TIME);
    
    -- If current time is before 10 PM, use today's date
    -- If current time is 10 PM or later, activities count for next day
    IF current_hour >= reset_hour THEN
        v_activity_date := CURRENT_DATE + INTERVAL '1 day';
    ELSE
        v_activity_date := CURRENT_DATE;
    END IF;
    
    -- Override with created_at date if available (for backdated activities)
    IF NEW.created_at IS NOT NULL THEN
        current_hour := EXTRACT(HOUR FROM NEW.created_at);
        IF current_hour >= reset_hour THEN
            v_activity_date := DATE(NEW.created_at) + INTERVAL '1 day';
        ELSE
            v_activity_date := DATE(NEW.created_at);
        END IF;
    END IF;
    
    -- ============================================
    -- NEW CHECK: Prevent earning from multiple activity types per day
    -- ============================================
    -- Rule: A user can earn Energy from only ONE activity type per day
    -- Walk, Run, and Cycle are all separate activity types
    -- Check if user already earned energy from a different activity type today
    SELECT dat.activity_type INTO existing_energy_activity_type
    FROM daily_activity_tracking dat
    WHERE dat.user_id = NEW.user_id 
      AND dat.activity_date = v_activity_date
      AND dat.total_energy_earned > 0
      AND dat.activity_type != NEW.activity_type
    LIMIT 1;
    
    -- If user already earned energy from another activity type, award 0 points
    IF existing_energy_activity_type IS NOT NULL THEN
        -- User already earned energy from a different activity type today
        -- Award 0 points for this activity
        points_earned := 0;
        
        -- Still insert/update daily_activity_tracking for record keeping (but with 0 energy)
        INSERT INTO daily_activity_tracking (
            user_id,
            activity_date,
            activity_type,
            total_distance_meters,
            total_energy_earned,
            activities_count
        ) VALUES (
            NEW.user_id,
            v_activity_date,
            NEW.activity_type,
            NEW.distance_meters, -- Track distance but no energy
            0, -- No energy earned
            1
        )
        ON CONFLICT (user_id, activity_date, activity_type) 
        DO UPDATE SET
            total_distance_meters = daily_activity_tracking.total_distance_meters + NEW.distance_meters,
            activities_count = daily_activity_tracking.activities_count + 1,
            updated_at = NOW();
        
        -- Log that energy was blocked due to multiple activity types
        INSERT INTO energy_points_history 
            (user_id, points_change, transaction_type, description, 
             related_activity_id)
        VALUES 
            (NEW.user_id, 0, 'blocked', 
             'Energy blocked: Already earned energy from ' || existing_energy_activity_type || 
             ' activity today. Only one activity type per day can earn energy.',
             NEW.id);
        
        -- Update streak tracking (still counts for streak, just no energy)
        PERFORM update_user_streak(NEW.user_id, v_activity_date);
        
        RETURN NEW;
    END IF;
    
    -- ============================================
    -- Continue with normal energy calculation
    -- ============================================
    
    -- Calculate distance in kilometers
    distance_km := NEW.distance_meters / 1000.0;
    
    -- Set limits and rates based on activity type
    IF NEW.activity_type = 'cycle' THEN
        -- Cycling: 7 Energy per 1 KM, minimum 7, 30 KM/day limit
        energy_per_km := 7;
        min_energy := 7;
        daily_limit_meters := 30000; -- 30 KM
        daily_limit_energy := 210; -- 30 KM * 7 = 210 Energy max
    ELSE
        -- Walk/Run: 10 Energy per 1 KM, minimum 10, 15 KM/day limit
        energy_per_km := 10;
        min_energy := 10;
        daily_limit_meters := 15000; -- 15 KM
        daily_limit_energy := 150; -- 15 KM * 10 = 150 Energy max
    END IF;
    
    -- Calculate base energy points
    -- Start at 0, only award points after 200m
    -- Formula: If distance < 200m: 0, else GREATEST(min_energy, FLOOR(distance_km) * energy_per_km)
    IF NEW.distance_meters < 200 THEN
        points_earned := 0;
    ELSE
        points_earned := GREATEST(min_energy, FLOOR(distance_km)::INTEGER * energy_per_km);
    END IF;
    
    -- Check daily limit for this activity type
    -- Get today's total distance and energy for this activity type
    SELECT 
        COALESCE(SUM(dat.total_distance_meters), 0),
        COALESCE(SUM(dat.total_energy_earned), 0)
    INTO daily_distance_meters, daily_energy_earned
    FROM daily_activity_tracking dat
    WHERE dat.user_id = NEW.user_id 
      AND dat.activity_date = v_activity_date
      AND dat.activity_type = NEW.activity_type;
    
    -- Calculate remaining distance and energy for today
    remaining_distance_meters := GREATEST(0, daily_limit_meters - daily_distance_meters);
    remaining_distance_meters := LEAST(remaining_distance_meters, NEW.distance_meters);
    
    -- If user has exceeded daily limit, reduce points accordingly
    IF daily_distance_meters >= daily_limit_meters THEN
        -- Already hit daily limit, award 0 points
        points_earned := 0;
    ELSIF (daily_distance_meters + NEW.distance_meters) > daily_limit_meters THEN
        -- This activity would exceed limit, only award points for remaining distance
        eligible_distance_meters := remaining_distance_meters;
        points_earned := GREATEST(min_energy, FLOOR(eligible_distance_meters / 1000.0)::INTEGER * energy_per_km);
        
        -- Also cap at remaining daily energy limit
        IF (daily_energy_earned + points_earned) > daily_limit_energy THEN
            points_earned := GREATEST(0, daily_limit_energy - daily_energy_earned);
        END IF;
    END IF;
    
    -- Update or insert daily activity tracking (separate by activity type)
    INSERT INTO daily_activity_tracking (
        user_id,
        activity_date,
        activity_type,
        total_distance_meters,
        total_energy_earned,
        activities_count
    ) VALUES (
        NEW.user_id,
        v_activity_date,
        NEW.activity_type,
        LEAST(NEW.distance_meters, remaining_distance_meters), -- Cap at remaining limit
        points_earned,
        1
    )
    ON CONFLICT (user_id, activity_date, activity_type) 
    DO UPDATE SET
        total_distance_meters = LEAST(
            daily_activity_tracking.total_distance_meters + LEAST(NEW.distance_meters, remaining_distance_meters),
            daily_limit_meters
        ),
        total_energy_earned = LEAST(
            daily_activity_tracking.total_energy_earned + points_earned,
            daily_limit_energy
        ),
        activities_count = daily_activity_tracking.activities_count + 1,
        updated_at = NOW();
    
    -- Update user's total energy points (only if points > 0)
    IF points_earned > 0 THEN
        UPDATE users 
        SET energy_points = energy_points + points_earned
        WHERE id = NEW.user_id;
        
        -- Log the transaction
        INSERT INTO energy_points_history 
            (user_id, points_change, transaction_type, description, 
             related_activity_id)
        VALUES 
            (NEW.user_id, points_earned, 'earned', 
             'Points earned for ' || NEW.activity_type || ' activity (' || 
             ROUND(NEW.distance_meters)::TEXT || 'm = ' || points_earned::TEXT || ' points)',
             NEW.id);
    END IF;
    
    -- Update streak tracking
    PERFORM update_user_streak(NEW.user_id, v_activity_date);
    
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Step 2: Ensure trigger exists
DROP TRIGGER IF EXISTS award_points_on_activity_insert ON activity_sessions;
CREATE TRIGGER award_points_on_activity_insert
    AFTER INSERT ON activity_sessions
    FOR EACH ROW EXECUTE FUNCTION award_energy_points_for_activity();

-- Step 3: Grant permissions
GRANT EXECUTE ON FUNCTION award_energy_points_for_activity TO authenticated;

-- Step 4: Comments
COMMENT ON FUNCTION award_energy_points_for_activity IS 
    'Awards energy points with restriction: Only ONE activity type per day can earn energy. Walk/Run = 10 Energy per 1 KM (15 KM/day limit). Cycling = 7 Energy per 1 KM (30 KM/day limit). Daily reset at 10 PM. If user already earned energy from one activity type, other activity types will earn 0 energy for that day.';

