-- Recreates the TABLE SHAPE deployed by the mobile repo's
-- 20261006170000_location_tracking_batch_sync.sql — centre columns, no
-- latitude/longitude/is_active — so the run below proves that
-- 20261102000001 reconciles a database that already holds the OLD shape,
-- including backfilling a row that was written before the migration existed.
--
-- The generated PostGIS `geom` column is omitted: postgres:16-alpine has no
-- postgis extension available. Its presence or absence is irrelevant to the
-- reconciliation under test (the migration skips it when the type is missing).
create table if not exists public.branch_geofences (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references public.branches(id) on delete cascade,
  radius_meters numeric(10, 2) NOT NULL DEFAULT 100,
  center_lat numeric(10, 6) NOT NULL,
  center_lng numeric(10, 6) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

insert into public.branches (id, branch_name, branch_code, latitude, longitude,
                             geofence_radius, geofence_active, location, updated_at)
values ('11111111-1111-4111-8111-111111111114', 'Lekki Branch', 'LKK',
        null, null, null, false, 'Lagos', now())
on conflict (id) do nothing;

insert into public.branch_geofences (id, branch_id, radius_meters, center_lat, center_lng, active)
values ('33333333-3333-4333-8333-333333333333',
        '11111111-1111-4111-8111-111111111114',
        250, 6.447000, 3.470000, true)
on conflict (id) do nothing;
