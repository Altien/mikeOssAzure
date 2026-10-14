-- Source743311cc adaptation: forward delta for the already-applied source117 check.
-- Number provisional until index119 in the current Dev migration stream.
alter table public.user_profiles drop constraint if exists user_profiles_profile_photo_check;
alter table public.user_profiles add constraint user_profiles_profile_photo_check
  check (profile_photo is null or (
    octet_length(profile_photo) <= 699116
    and profile_photo ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'
  )) not valid;
