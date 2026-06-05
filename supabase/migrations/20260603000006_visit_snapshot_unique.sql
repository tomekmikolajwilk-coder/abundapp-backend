-- Przed stworzeniem unikalnego indeksu usuwamy duplikaty — zostawiamy tylko
-- najnowszy visit-snapshot na usera (pozostałe to artefakty z testów).
delete from public.portfolio_snapshots
where source = 'visit'
  and id not in (
    select distinct on (user_id) id
    from public.portfolio_snapshots
    where source = 'visit'
    order by user_id, captured_at desc
  );

-- Każdy user może mieć maksymalnie jeden wiersz z source='visit' —
-- zawsze reprezentuje tylko ostatnią wizytę, nie historię wizyt.
create unique index portfolio_snapshots_one_visit_per_user
  on public.portfolio_snapshots (user_id)
  where source = 'visit';
