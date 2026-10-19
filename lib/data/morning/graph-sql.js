// Accepted Task 0 graph algorithms, including Decision 13's measured refinements.
// Test equality pins the fixed function definitions to the measured prototype.
export const relationshipEdges = ({ orgId }) => ({
  name: 'relationshipEdges', dependencies: [], values: [orgId],
  text: `CREATE TEMP TABLE mv_relationship_edge ON COMMIT DROP AS
    SELECT a, b FROM morning_relationship_edge WHERE org_id = $1`,
});

// Fixed definitions use replacement on each computation: pg_temp functions survive
// COMMIT on a pooled backend even though the tables below use ON COMMIT DROP.
export const componentFunction = {
  name: 'componentFunction', dependencies: [], values: [],
  text: `CREATE OR REPLACE FUNCTION pg_temp.mv_components(
    vertices bigint[], edge_a bigint[], edge_b bigint[]) RETURNS bigint[]
  LANGUAGE plpgsql AS $$
  DECLARE
    n integer := coalesce(cardinality(vertices), 0);
    parent integer[] := array_fill(0, ARRAY[n]);
    ranks integer[] := array_fill(0, ARRAY[n]);
    labels bigint[] := vertices;
    output bigint[] := vertices;
    positions integer[];
    span bigint := CASE WHEN n>0 THEN vertices[n]-vertices[1]+1 ELSE 0 END;
    i integer; j integer; k integer; a integer; b integer; x integer;
    low integer; high integer; mid integer; wanted bigint; endpoints integer[];
    expires timestamptz := clock_timestamp() + interval '5 seconds';
  BEGIN
    IF cardinality(edge_a) IS DISTINCT FROM cardinality(edge_b) THEN
      RAISE EXCEPTION 'edge arrays differ in length';
    END IF;
    -- A bounded dense-ID lookup is linear space even for adversarial bigint IDs.
    -- Sparse IDs retain the binary-search path; no allocation uses the ID span
    -- unless it is at most twice the actual vertex count.
    IF n>0 AND span>0 AND span<=2::bigint*n THEN positions:=array_fill(0,ARRAY[span::int]); END IF;
    FOR i IN 1..n LOOP
      parent[i] := i;
      IF positions IS NOT NULL THEN positions[(vertices[i]-vertices[1]+1)::int]:=i; END IF;
      IF i > 1 AND vertices[i] <= vertices[i-1] THEN
        RAISE EXCEPTION 'vertices must be strictly increasing';
      END IF;
    END LOOP;
    FOR i IN 1..coalesce(cardinality(edge_a),0) LOOP
      IF i % 256 = 0 AND clock_timestamp() >= expires THEN
        RAISE EXCEPTION 'component deadline' USING ERRCODE = '57014';
      END IF;
      IF positions IS NOT NULL THEN
        IF edge_a[i]<vertices[1] OR edge_a[i]>vertices[n] OR edge_b[i]<vertices[1] OR edge_b[i]>vertices[n] THEN
          RAISE EXCEPTION 'edge endpoint outside vertices';
        END IF;
        a:=positions[(edge_a[i]-vertices[1]+1)::int];
        b:=positions[(edge_b[i]-vertices[1]+1)::int];
        IF a IS NULL OR b IS NULL OR a=0 OR b=0 THEN RAISE EXCEPTION 'edge endpoint outside vertices'; END IF;
      ELSE
        endpoints := ARRAY[0,0];
        FOR k IN 1..2 LOOP
          wanted := CASE WHEN k = 1 THEN edge_a[i] ELSE edge_b[i] END;
          low := 1; high := n;
          WHILE low <= high LOOP
            mid := (low + high) / 2;
            IF vertices[mid] = wanted THEN endpoints[k] := mid; EXIT;
            ELSIF vertices[mid] < wanted THEN low := mid + 1;
            ELSE high := mid - 1; END IF;
          END LOOP;
          IF endpoints[k] IS NULL OR endpoints[k] = 0 THEN RAISE EXCEPTION 'edge endpoint outside vertices'; END IF;
        END LOOP;
        a := endpoints[1]; b := endpoints[2];
      END IF;
      WHILE parent[a] <> a LOOP parent[a] := parent[parent[a]]; a := parent[a]; END LOOP;
      WHILE parent[b] <> b LOOP parent[b] := parent[parent[b]]; b := parent[b]; END LOOP;
      IF a <> b THEN
        IF ranks[a] < ranks[b] THEN x := a; a := b; b := x; END IF;
        parent[b] := a;
        labels[a] := least(labels[a],labels[b]);
        IF ranks[a] = ranks[b] THEN ranks[a] := ranks[a] + 1; END IF;
      END IF;
    END LOOP;
    FOR i IN 1..n LOOP
      IF i % 256 = 0 AND clock_timestamp() >= expires THEN
        RAISE EXCEPTION 'component deadline' USING ERRCODE = '57014';
      END IF;
      j := parent[i];
      WHILE parent[j] <> j LOOP parent[j] := parent[parent[j]]; j := parent[j]; END LOOP;
      parent[i] := j; output[i] := labels[j];
    END LOOP;
    RETURN output;
  END $$`,
};

export const relationshipComponents = () => ({
  name: 'relationshipComponents', dependencies: ['members', 'relationshipEdges', 'edgeIndex', 'componentFunction'], values: [],
  text: `CREATE TEMP TABLE mv_relationship_component ON COMMIT DROP AS
    WITH v AS (SELECT array_agg(DISTINCT id ORDER BY id) ids FROM (
      SELECT txn_id id FROM mv_dup_member UNION ALL
      -- Every edge is materialized in both directions, so a includes every endpoint.
      SELECT a FROM mv_relationship_edge) ids),
    e AS (SELECT array_agg(e.a) a, array_agg(e.b) b FROM mv_relationship_edge e
      WHERE e.a < e.b)
    SELECT unnest(v.ids) txn_id, unnest(pg_temp.mv_components(v.ids,e.a,e.b)) class
    FROM v CROSS JOIN e`,
});

export async function installGraphFunctions(tx) {
  for (const spec of [componentFunction, candidateFunction, upperFunction, pairFunction, pairPageFunction, hashFunction]) {
    await execute(tx, spec);
  }
}

// One date-ordered sweep constructs the nearest-different-class certificate,
// unions it, and counts the complete graph with a sliding five-day window.
export const candidateFunction = { name: 'candidateFunction', dependencies: [], values: [], text: `
CREATE OR REPLACE FUNCTION pg_temp.mv_candidates(days integer[], classes integer[])
RETURNS TABLE(pos integer, component integer, pair_contribution bigint) LANGUAGE plpgsql AS $$
DECLARE n integer:=coalesce(cardinality(days),0); parents integer[]:=array_fill(0,ARRAY[n]);
 ranks integer[]:=array_fill(0,ARRAY[n]); labels integer[]:=array_fill(0,ARRAY[n]);
 freq integer[]:=array_fill(0,ARRAY[n+1]); contributions bigint[]:=array_fill(0::bigint,ARRAY[n]);
 i integer; j integer; a integer; b integer; k integer; run_start integer:=1; run_end integer;
 left_i integer:=1; expires timestamptz:=clock_timestamp()+interval '5 seconds';
BEGIN
 IF cardinality(classes) IS DISTINCT FROM cardinality(days) THEN RAISE EXCEPTION 'array lengths'; END IF;
 FOR i IN 1..n LOOP
  IF classes[i]<1 OR classes[i]>n+1 OR (i>1 AND days[i]<days[i-1]) THEN RAISE EXCEPTION 'candidate order/class'; END IF;
  parents[i]:=i; labels[i]:=i;
 END LOOP;
 WHILE run_start<=n LOOP
  run_end:=run_start;
  WHILE run_end<n AND classes[run_end+1]=classes[run_start] LOOP run_end:=run_end+1; END LOOP;
  FOR i IN run_start..run_end LOOP
   IF i%256=0 AND clock_timestamp()>=expires THEN RAISE EXCEPTION 'candidate deadline' USING ERRCODE='57014'; END IF;
   FOR k IN 1..2 LOOP
    j:=CASE k WHEN 1 THEN run_start-1 ELSE run_end+1 END;
    IF j<1 OR j>n OR abs(days[i]-days[j])>5 THEN CONTINUE; END IF;
    a:=i; b:=j;
    WHILE parents[a]<>a LOOP parents[a]:=parents[parents[a]]; a:=parents[a]; END LOOP;
    WHILE parents[b]<>b LOOP parents[b]:=parents[parents[b]]; b:=parents[b]; END LOOP;
    IF a<>b THEN
     IF ranks[a]<ranks[b] THEN j:=a; a:=b; b:=j; END IF;
     parents[b]:=a; labels[a]:=least(labels[a],labels[b]);
     IF ranks[a]=ranks[b] THEN ranks[a]:=ranks[a]+1; END IF;
    END IF;
   END LOOP;
  END LOOP;
  run_start:=run_end+1;
 END LOOP;
 FOR i IN 1..n LOOP
  WHILE days[left_i]<days[i]-5 LOOP freq[classes[left_i]]:=freq[classes[left_i]]-1; left_i:=left_i+1; END LOOP;
  contributions[i]:=i-left_i-freq[classes[i]]; freq[classes[i]]:=freq[classes[i]]+1;
  a:=i;
  WHILE parents[a]<>a LOOP parents[a]:=parents[parents[a]]; a:=parents[a]; END LOOP;
  pos:=i; component:=labels[a]; pair_contribution:=contributions[i]; RETURN NEXT;
 END LOOP;
END $$` };

export const upperFunction = { name: 'upperFunction', dependencies: [], values: [], text: `
CREATE OR REPLACE FUNCTION pg_temp.mv_upper(ids bigint[], wanted bigint, first_i integer, last_i integer)
RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE low integer:=first_i; high integer:=last_i+1; mid integer;
BEGIN
 WHILE low<high LOOP mid:=(low+high)/2;
  IF ids[mid]<=wanted THEN low:=mid+1; ELSE high:=mid; END IF;
 END LOOP; RETURN low;
END $$` };

// A day needs only its maximum ID and maximum ID outside that ID's class
// to decide whether a lo has any partner. No per-member suffix counts/sorts.
// All input arrays contain members, never pairs; one SELECT sorts active IDs.
export const pairFunction = { name: 'pairFunction', dependencies: ['upperFunction'], values: [], internalQueries: 1, text: `
CREATE OR REPLACE FUNCTION pg_temp.mv_pair_work(ids bigint[], days integer[], classes bigint[],
 after_lo bigint, after_hi bigint, page_size integer) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE n integer:=coalesce(cardinality(ids),0); ends integer[]:=array_fill(0,ARRAY[n]);
 bucket_day integer[]:='{}'; starts integer[]:='{}'; stops integer[]:='{}'; alternatives integer[]:='{}'; buckets integer:=0;
 active_ids bigint[]:='{}'; active_pos integer[]:='{}'; active_unsorted integer[]:='{}';
 i integer; j integer; k integer; b integer; l integer; h integer; mid integer; p integer;
 total bigint; chosen bigint; chosen_pos integer; cursor_hi bigint;
 probes integer:=0; searches integer:=0; rows jsonb:='[]'; found integer:=0; has_more boolean:=false;
 expires timestamptz:=clock_timestamp()+interval '5 seconds';
BEGIN
 IF page_size<1 OR page_size>50 THEN RAISE EXCEPTION 'page size'; END IF;
 IF cardinality(days) IS DISTINCT FROM n OR cardinality(classes) IS DISTINCT FROM n THEN RAISE EXCEPTION 'array lengths'; END IF;
 FOR i IN 1..n LOOP
  IF i=1 OR days[i]<>days[i-1] THEN
   buckets:=buckets+1; bucket_day[buckets]:=days[i]; starts[buckets]:=i; alternatives[buckets]:=0;
   IF buckets>1 THEN stops[buckets-1]:=i-1; END IF;
  ELSIF classes[i]<>classes[i-1] THEN alternatives[buckets]:=i-1;
  END IF;
 END LOOP;
 IF n>0 THEN stops[buckets]:=n; END IF;
 FOR i IN REVERSE n..1 LOOP
  ends[i]:=CASE WHEN i<n AND days[i]=days[i+1] AND classes[i]=classes[i+1] THEN ends[i+1] ELSE i END;
 END LOOP;
 FOR i IN 1..n LOOP
  IF i%256=0 AND clock_timestamp()>=expires THEN RAISE EXCEPTION 'pair index deadline' USING ERRCODE='57014'; END IF;
  total:=0;
  FOR k IN -5..5 LOOP
   l:=1; h:=buckets+1;
   WHILE l<h LOOP mid:=(l+h)/2; IF bucket_day[mid]<days[i]+k THEN l:=mid+1; ELSE h:=mid; END IF; END LOOP;
   b:=l; IF b>buckets OR bucket_day[b]<>days[i]+k THEN CONTINUE; END IF;
   p:=CASE WHEN classes[stops[b]]<>classes[i] THEN stops[b] ELSE alternatives[b] END;
   IF p>0 AND ids[p]>ids[i] THEN total:=1; EXIT; END IF;
  END LOOP;
  IF total>0 THEN active_unsorted:=array_append(active_unsorted,i); END IF;
 END LOOP;
 SELECT array_agg(ids[u.i] ORDER BY ids[u.i]),array_agg(u.i ORDER BY ids[u.i])
 INTO active_ids,active_pos FROM unnest(active_unsorted) u(i);
 searches:=1;
 j:=pg_temp.mv_upper(active_ids,coalesce(after_lo,0)-1,1,coalesce(cardinality(active_ids),0));
 WHILE j<=coalesce(cardinality(active_ids),0) LOOP
  i:=active_pos[j]; cursor_hi:=CASE WHEN ids[i]=after_lo THEN greatest(ids[i],after_hi) ELSE ids[i] END;
  LOOP
   chosen:=NULL; chosen_pos:=NULL;
   FOR k IN -5..5 LOOP
    probes:=probes+1; l:=1; h:=buckets+1;
    WHILE l<h LOOP mid:=(l+h)/2; IF bucket_day[mid]<days[i]+k THEN l:=mid+1; ELSE h:=mid; END IF; END LOOP;
    b:=l; IF b>buckets OR bucket_day[b]<>days[i]+k THEN CONTINUE; END IF;
    p:=pg_temp.mv_upper(ids,cursor_hi,starts[b],stops[b]);
    IF p<=stops[b] AND classes[p]=classes[i] THEN p:=ends[p]+1; END IF;
    IF p<=stops[b] AND (chosen IS NULL OR ids[p]<chosen) THEN chosen:=ids[p]; chosen_pos:=p; END IF;
   END LOOP;
   EXIT WHEN chosen IS NULL;
   found:=found+1;
   IF found>page_size THEN has_more:=true; EXIT; END IF;
   rows:=rows||jsonb_build_array(jsonb_build_object('lo',ids[i],'hi',chosen,
    'loDate',to_char(DATE '2000-01-01'+days[i],'YYYY-MM-DD'),'hiDate',to_char(DATE '2000-01-01'+days[chosen_pos],'YYYY-MM-DD')));
   cursor_hi:=chosen;
  END LOOP;
  EXIT WHEN has_more; j:=j+1;
 END LOOP;
 RETURN jsonb_build_object('pairs',rows,'next',CASE WHEN has_more THEN
  jsonb_build_object('lo',rows->(page_size-1)->'lo','hi',rows->(page_size-1)->'hi') ELSE NULL END,
  'work',jsonb_build_object('listProbes',probes,'activeLoSearches',searches));
END $$` };

export const pairPageFunction={name:'pairPageFunction',dependencies:['pairFunction'],values:[],text:`
CREATE OR REPLACE FUNCTION pg_temp.mv_pair_page(ids bigint[],days integer[],classes bigint[],after_lo bigint,after_hi bigint,page_size integer)
RETURNS TABLE(lo bigint,hi bigint) LANGUAGE sql AS $$
 SELECT p.lo,p.hi FROM jsonb_to_recordset(pg_temp.mv_pair_work(ids,days,classes,after_lo,after_hi,page_size)->'pairs') p(lo bigint,hi bigint)
$$`};

// The FOR SELECT is one internal data statement. Only one canonical record and
// each hash's fixed 32-byte state are live; no member list is concatenated.
export const hashFunction = { name: 'hashFunction', dependencies: ['candidateMembers'], values: [], internalQueries: 1, text: `
CREATE OR REPLACE FUNCTION pg_temp.mv_hash_groups()
RETURNS TABLE(component_key bigint,item_key text,version text) LANGUAGE plpgsql AS $$
DECLARE r record; previous bigint; member_hash bytea; cause_hash bytea; canonical_record text;
BEGIN
 FOR r IN SELECT * FROM mv_candidate_member ORDER BY component,txn_id LOOP
  IF previous IS DISTINCT FROM r.component THEN
   IF previous IS NOT NULL THEN component_key:=previous; item_key:='duplicate:'||encode(member_hash,'hex'); version:=encode(cause_hash,'hex'); RETURN NEXT; END IF;
   previous:=r.component; member_hash:=sha256(convert_to('duplicate-members|1','UTF8'));
   cause_hash:=sha256(convert_to('duplicate|1|'||replace(replace(json_build_object('amount',abs(r.m),'family',r.family,'partyKey',r.party_key)::text,', ',','),': ',':'),'UTF8'));
  END IF;
  member_hash:=sha256(member_hash||convert_to(r.txn_id::text||E'\n','UTF8'));
  canonical_record:=replace(json_build_array(r.txn_id,to_char(r.txn_date,'YYYY-MM-DD'),r.m,r.partition_label)::text,', ',',')||E'\n';
  cause_hash:=sha256(cause_hash||convert_to(canonical_record,'UTF8'));
 END LOOP;
 IF previous IS NOT NULL THEN component_key:=previous; item_key:='duplicate:'||encode(member_hash,'hex'); version:=encode(cause_hash,'hex'); RETURN NEXT; END IF;
END $$` };

const spec = (name, text, values = [], dependencies = [], internalQueries = 0) =>
  ({ name, text, values, dependencies, internalQueries });


export async function execute(tx, query) {
  return tx.query(query.text, query.values);
}

export const duplicateMembers = () => spec('members', `
CREATE TEMP TABLE mv_dup_member ON COMMIT DROP AS
WITH f AS (SELECT txn_id,entity_id,party_key,family,m,txn_date,seed,type,kind,
 min(txn_id) OVER w family_group,bool_or(seed) OVER w seeded
 FROM mv_fact WHERE family IS NOT NULL AND party_key IS NOT NULL AND first_date=last_date AND first_date=txn_date
 WINDOW w AS (PARTITION BY entity_id,party_key,family,abs(m)))
SELECT *,txn_date-DATE '2000-01-01' AS day FROM f WHERE seeded`, [], ['eligibleFacts']);

export const candidateMembers = () => spec('candidateMembers', `
CREATE TEMP TABLE mv_candidate_member ON COMMIT DROP AS
WITH labeled AS (
 SELECT m.*,r.class,dense_rank() OVER(PARTITION BY family_group ORDER BY r.class)::int class_no
 FROM mv_dup_member m JOIN mv_relationship_component r USING(txn_id)
), grouped AS (
 SELECT family_group,array_agg(txn_id ORDER BY day,txn_id) ids,
 array_agg(day ORDER BY day,txn_id) days,array_agg(class_no ORDER BY day,txn_id) classes
 FROM labeled GROUP BY family_group
), components AS (
 SELECT g.ids[c.pos] txn_id,g.ids[c.component] component,c.pair_contribution
 FROM grouped g CROSS JOIN LATERAL pg_temp.mv_candidates(g.days,g.classes) c
), joined AS (
 SELECT m.*,c.component,c.pair_contribution,
 min(m.txn_id) OVER(PARTITION BY c.component,m.class) partition_label,
 count(*) OVER(PARTITION BY c.component) member_count,bool_or(m.seed) OVER(PARTITION BY c.component) component_seed
 FROM labeled m JOIN components c USING(txn_id)
)
SELECT * FROM joined WHERE member_count>1 AND component_seed`, [], ['members','relationshipComponents','candidateFunction']);

// The indexed, complete edge relation is still materialized once. Its consumers
// share statement-local member/component relations instead of extra temp tables.
// Reuse the accepted SQL verbatim so closure and restricted partition semantics
// have one implementation.
const selectOf = query => query.text.slice(query.text.indexOf(' ON COMMIT DROP AS')+' ON COMMIT DROP AS'.length).trim();
export const combinedCandidateMembers = () => spec('candidateMembers', `
CREATE TEMP TABLE mv_candidate_member ON COMMIT DROP AS
WITH mv_dup_member AS MATERIALIZED (${selectOf(duplicateMembers())}),
mv_relationship_component AS MATERIALIZED (${selectOf(relationshipComponents())}),
candidate AS (${selectOf(candidateMembers())}) SELECT * FROM candidate`, [], ['eligibleFacts','relationshipEdges','edgeIndex','componentFunction','candidateFunction']);

export const duplicateGroups = () => spec('duplicateGroups', `
CREATE TEMP TABLE mv_group ON COMMIT DROP AS
WITH summaries AS (
SELECT m.component,min(m.entity_id) entity_id,min(m.party_key) party_key,min(m.family) family,
 abs(min(m.m))::text amount_cents,count(*)::int member_count,sum(m.pair_contribution)::text pair_count,
 count(*) FILTER(WHERE m.seed)::int seed_count,min(m.txn_date) first_date,max(m.txn_date) last_date
FROM mv_candidate_member m GROUP BY m.component)
SELECT m.component,h.item_key,h.version,m.entity_id,m.party_key,m.family,m.amount_cents,m.member_count,m.pair_count,
 m.seed_count,m.first_date,m.last_date
FROM summaries m JOIN pg_temp.mv_hash_groups() h ON h.component_key=m.component`, [], ['candidateMembers','hashFunction'],1);
