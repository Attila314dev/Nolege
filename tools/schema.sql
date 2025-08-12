-- tools/schema.sql
create table if not exists questions (
  id serial primary key,
  category text not null,
  question text not null,
  correct text not null
);

create table if not exists wrong_answers (
  id serial primary key,
  question_id int not null references questions(id) on delete cascade,
  text text not null
);

-- Gyorsítás
create index if not exists idx_wrong_answers_qid on wrong_answers(question_id);
