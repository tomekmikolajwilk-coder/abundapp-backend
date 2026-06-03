-- Każdy user może mieć maksymalnie jeden wiersz z source='visit' —
-- zawsze reprezentuje tylko ostatnią wizytę, nie historię wizyt.
create unique index portfolio_snapshots_one_visit_per_user
  on public.portfolio_snapshots (user_id)
  where source = 'visit';
