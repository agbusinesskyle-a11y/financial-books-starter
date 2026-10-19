// Task 0 query specifications. Dependencies name the prerequisite relation builders;
// an EXPLAIN replay must start a fresh transaction, then run that dependency chain.
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
    WITH v AS (SELECT array_agg(id ORDER BY id) ids FROM (
      SELECT txn_id id FROM mv_dup_member UNION
      SELECT a FROM mv_relationship_edge UNION SELECT b FROM mv_relationship_edge) ids),
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

// Hook used by the probe to count every data statement and save its bound SQL.
export async function execute(tx, query) {
  if(tx.morningDeadline) {
    const remaining=Math.floor(tx.morningDeadline-performance.now());
    if(remaining<=0)throw Object.assign(new Error('computation deadline exceeded'),{code:'57014'});
    await tx.query(`SET LOCAL statement_timeout=${Math.min(5000,remaining)}`);
  }
  if (tx.probeExecute) return tx.probeExecute(query);
  try { return await tx.query({ text: query.text, values: query.values, query_timeout: 20_000 }); }
  catch(error) { error.message=`${query.name}: ${error.message}`; throw error; }
}

// Shared by eligibility and party resolution. NULLs do not contribute to either
// distinct count; customer/vendor namespaces remain separate even for equal IDs.
export const partyFacts = ({orgId}) => spec('partyFacts', `
CREATE TEMP TABLE mv_party ON COMMIT DROP AS
SELECT txn_id,count(DISTINCT customer_id)+count(DISTINCT vendor_id) party_count,
 least(min('c:'||customer_id),min('v:'||vendor_id)) party_key
FROM posting WHERE org_id=$1 AND (customer_id IS NOT NULL OR vendor_id IS NOT NULL)
GROUP BY txn_id`,[orgId]);

export const eligibleNets = ({ orgId, N, baselineAt }) => spec('eligibleNets', `
CREATE TEMP TABLE mv_net ON COMMIT DROP AS
WITH relevant AS MATERIALIZED (
 SELECT txn_id FROM txn WHERE org_id=$1 AND created_at>$3::timestamptz AND created_at<=$2::timestamptz
 UNION SELECT txn_id FROM txn WHERE org_id=$1 AND updated_at>$3::timestamptz AND updated_at<=$2::timestamptz
 UNION SELECT txn_id FROM txn WHERE org_id=$1 AND (customer_id IS NOT NULL OR vendor_id IS NOT NULL)
 UNION SELECT txn_id FROM mv_party
), nets AS (
 SELECT p.txn_id,p.account_id,p.entity_id,a.type account_type,sum(p.amount_cents) m,
  min(p.txn_date) first_date,max(p.txn_date) last_date
 FROM relevant r JOIN posting p USING(txn_id) JOIN account a USING(org_id,account_id)
 WHERE p.org_id=$1 AND a.type IN ('bank','credit_card') AND p.txn_date<=($2::timestamptz AT TIME ZONE 'America/Phoenix')::date
 GROUP BY p.txn_id,p.account_id,p.entity_id,a.type HAVING sum(p.amount_cents)<>0
)
SELECT n.*,t.type,t.txn_date,t.created_at,t.updated_at,t.customer_id,t.vendor_id,
 ((t.created_at>$3::timestamptz AND t.created_at<=$2::timestamptz) OR
  (t.updated_at>$3::timestamptz AND t.updated_at<=$2::timestamptz)) seed,
 CASE WHEN t.created_at>$3::timestamptz AND t.created_at<=$2::timestamptz THEN 'added' ELSE 'historical_edit' END kind
FROM nets n JOIN txn t USING(txn_id)
WHERE t.voided_at IS NULL AND t.txn_date<=($2::timestamptz AT TIME ZONE 'America/Phoenix')::date`, [orgId,N,baselineAt],['partyFacts']);

export const eligibleFacts = ({orgId}) => spec('eligibleFacts', `
CREATE TEMP TABLE mv_fact ON COMMIT DROP AS
WITH f AS (
 SELECT n.txn_id,n.entity_id,n.type,n.txn_date,bool_or(n.seed) seed,min(n.kind) kind,
 sum(n.m) m,min(n.first_date) first_date,max(n.last_date) last_date,
 count(*) FILTER(WHERE n.m>0) positive,count(*) FILTER(WHERE n.m<0) negative,
 bool_and(n.account_type='credit_card') cards,
 coalesce('c:'||min(n.customer_id),'v:'||min(n.vendor_id)) header,
 coalesce(min(p.party_count),0) party_count,min(p.party_key) line_party
 FROM mv_net n LEFT JOIN mv_party p USING(txn_id)
 GROUP BY n.txn_id,n.entity_id,n.type,n.txn_date
)
SELECT f.*,CASE WHEN party_count=0 THEN header WHEN party_count=1 AND (header IS NULL OR header=line_party) THEN line_party END party_key,
 CASE WHEN type IN ('check','expense','bill_payment') AND m<0 AND positive=0 THEN 'outgoing-payment'
 WHEN type IN ('payment','sales_receipt','deposit') AND m>0 AND negative=0 THEN 'incoming-receipt'
 WHEN type='cc_credit' AND m>0 AND cards THEN 'card-refund'
 WHEN type='journal_entry' AND m<0 AND positive=0 THEN 'journal-out'
 WHEN type='journal_entry' AND m>0 AND negative=0 THEN 'journal-in' END family
FROM f`, [], ['eligibleNets','partyFacts']);

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

export const duplicateGroups = () => spec('duplicateGroups', `
CREATE TEMP TABLE mv_group ON COMMIT DROP AS
SELECT m.component,h.item_key,h.version,min(m.entity_id) entity_id,min(m.party_key) party_key,min(m.family) family,
 abs(min(m.m))::text amount_cents,count(*)::int member_count,sum(m.pair_contribution)::text pair_count,
 count(*) FILTER(WHERE m.seed)::int seed_count,min(m.txn_date) first_date,max(m.txn_date) last_date
FROM mv_candidate_member m JOIN pg_temp.mv_hash_groups() h ON h.component_key=m.component
GROUP BY m.component,h.item_key,h.version`, [], ['candidateMembers','hashFunction'],1);

export const balanceQuery = ({orgId,N,baselineAt}) => spec('balances', `
CREATE TEMP TABLE mv_money ON COMMIT DROP AS
WITH amount AS (
 SELECT p.account_id,sum(p.amount_cents)::text balance,
 sum(p.amount_cents) FILTER(WHERE p.txn_date=($2::timestamptz AT TIME ZONE 'America/Phoenix')::date)::text today
 FROM posting p JOIN txn t USING(org_id,txn_id)
 WHERE p.org_id=$1 AND t.voided_at IS NULL AND p.txn_date<=($2::timestamptz AT TIME ZONE 'America/Phoenix')::date GROUP BY p.account_id
), current AS (
 SELECT a.account_id,a.entity_id,a.name,a.type,a.active,e.name entity_name,p.return_type='household_1040' personal,
 coalesce(x.balance,'0') balance,coalesce(x.today,'0') today,
 coalesce(c.home,'USD') home FROM account a JOIN entity e USING(org_id,entity_id) LEFT JOIN amount x USING(account_id)
 LEFT JOIN currency_settings c USING(org_id,entity_id) LEFT JOIN tax_profile p USING(org_id,entity_id)
 WHERE a.org_id=$1 AND a.type IN ('bank','credit_card')
), baseline AS (
 SELECT s.* FROM morning_snapshot_account s JOIN morning_snapshot_generation g USING(org_id,viewer_key,generation_id)
 WHERE s.org_id=$1 AND s.viewer_key='owner' AND g.captured_at=$3::timestamptz
)
SELECT c.*,b.observed_account_id,b.observed_entity_id,b.account_name,b.account_type,b.signed_cents::text baseline
FROM current c FULL JOIN baseline b ON b.observed_account_id=c.account_id ORDER BY coalesce(c.account_id,b.observed_account_id)`,[orgId,N,baselineAt]);

export const documentQuery = ({orgId,N}) => spec('documents', `
CREATE TEMP TABLE mv_document ON COMMIT DROP AS
WITH applied AS (
 SELECT txn_id,sum(amount_cents) used FROM (
 SELECT credit_txn_id txn_id,amount_cents FROM application WHERE org_id=$1 AND applied_on<=($2::timestamptz AT TIME ZONE 'America/Phoenix')::date
 UNION ALL SELECT charge_txn_id,amount_cents FROM application WHERE org_id=$1 AND applied_on<=($2::timestamptz AT TIME ZONE 'America/Phoenix')::date
 ) a GROUP BY txn_id
)
SELECT t.*,t.total_cents-coalesce(a.used,0) remaining,
 t.due_date<($2::timestamptz AT TIME ZONE 'America/Phoenix')::date overdue,
 (t.type='bill' AND (t.approval_status='awaiting' OR t.due_date<=($2::timestamptz AT TIME ZONE 'America/Phoenix')::date+7))
 OR (t.type='invoice' AND t.due_date<($2::timestamptz AT TIME ZONE 'America/Phoenix')::date) attention
FROM txn t LEFT JOIN applied a USING(txn_id)
WHERE t.org_id=$1 AND t.type IN ('bill','invoice') AND t.voided_at IS NULL
 AND t.txn_date<=($2::timestamptz AT TIME ZONE 'America/Phoenix')::date AND t.total_cents-coalesce(a.used,0)>0`,[orgId,N]);

export const bankQuery = ({orgId}) => spec('bankItems', `
CREATE TEMP TABLE mv_bank ON COMMIT DROP AS
SELECT b.*,a.books_account_id,a.include,
 b.bank_state='active' AND b.review_state='new' AND NOT b.pending actionable,
 b.attention IS NOT NULL warning,
 b.bank_state='active' AND b.review_state='new' AND b.pending AND b.attention IS NULL pending_only
FROM bank_feed_item b JOIN ledgerline_account a USING(org_id,entity_id,ll_account_id)
JOIN account k ON k.org_id=a.org_id AND k.entity_id=a.entity_id AND k.account_id=a.books_account_id AND k.type IN ('bank','credit_card')
WHERE b.org_id=$1 AND a.include`,[orgId]);

export const bankHashFunction = spec('bankHashFunction', `
CREATE OR REPLACE FUNCTION pg_temp.mv_bank_hash()
RETURNS TABLE(entity_id bigint,ll_account_id uuid,currency text,version text) LANGUAGE plpgsql AS $$
DECLARE r record; previous text; h bytea; record_text text;
BEGIN
 FOR r IN SELECT b.* FROM mv_bank b WHERE actionable OR warning OR pending_only ORDER BY b.entity_id,b.ll_account_id,b.currency,b.item_id LOOP
  IF previous IS DISTINCT FROM r.entity_id::text||':'||r.ll_account_id::text||r.currency THEN
   IF previous IS NOT NULL THEN version:=encode(h,'hex'); RETURN NEXT; END IF;
   previous:=r.entity_id::text||':'||r.ll_account_id::text||r.currency; entity_id:=r.entity_id; ll_account_id:=r.ll_account_id; currency:=r.currency;
   h:=sha256(convert_to('bank|1|'||json_build_array(r.books_account_id,r.include,r.currency)::text,'UTF8'));
  END IF;
  record_text:=json_build_array(r.item_id,r.ll_transaction_id,r.revision,r.review_version,r.bank_state,r.review_state,
   r.pending,r.attention,r.parked_attention,r.amount_cents,r.currency)::text;
  h:=sha256(h||convert_to(record_text,'UTF8'));
 END LOOP;
 IF previous IS NOT NULL THEN version:=encode(h,'hex'); RETURN NEXT; END IF;
END $$`);

export const transferQuery = () => spec('transfers', `
CREATE TEMP TABLE mv_transfer ON COMMIT DROP AS
WITH leg AS (
 SELECT txn_id,account_id,entity_id,m,first_date,
 row_number() OVER(ORDER BY entity_id,txn_id,account_id) ordinal FROM mv_net
 WHERE seed AND account_type='bank' AND first_date=last_date
), daily AS (
 SELECT abs(m) amount,sign(m) direction,first_date date,count(*) n,sum(ordinal) ids FROM leg GROUP BY 1,2,3
), entity_day AS (
 SELECT entity_id,abs(m) amount,sign(m) direction,first_date date,count(*) n,sum(ordinal) ids FROM leg GROUP BY 1,2,3,4
), bucket_degree AS (
 SELECT l.entity_id,l.amount,l.direction,l.date,
 sum(coalesce(d.n,0)-coalesce(e.n,0))::int degree,sum(coalesce(d.ids,0)-coalesce(e.ids,0)) partner
 FROM entity_day l CROSS JOIN generate_series(-3,3) offset_day
 LEFT JOIN daily d ON d.amount=l.amount AND d.direction=-l.direction AND d.date=l.date+offset_day
 LEFT JOIN entity_day e ON e.amount=d.amount AND e.direction=d.direction AND e.date=d.date AND e.entity_id=l.entity_id
 GROUP BY l.entity_id,l.amount,l.direction,l.date
), degree AS (
 SELECT l.*,d.degree,d.partner FROM leg l JOIN bucket_degree d
 ON d.entity_id=l.entity_id AND d.amount=abs(l.m) AND d.direction=sign(l.m) AND d.date=l.first_date
)
SELECT l.txn_id out_txn,l.account_id out_account,r.txn_id in_txn,r.account_id in_account,l.m
FROM degree l JOIN degree r ON r.ordinal=l.partner AND r.partner=l.ordinal
WHERE l.degree=1 AND r.degree=1 AND l.m<0`,[],['eligibleNets']);

export const attentionQuery = ({orgId,N}) => spec('attention', `
CREATE TEMP TABLE mv_attention ON COMMIT DROP AS
WITH bank AS (
 SELECT b.entity_id,'bank:'||b.entity_id||':'||b.ll_account_id||':'||b.currency item_key,'bank' rule,
 h.version, min(b.posted_date) date,1 severity,
 jsonb_build_object('needsReviewCount',count(*) FILTER(WHERE b.actionable OR b.warning),
 'pendingCount',count(*) FILTER(WHERE b.pending_only),'currency',b.currency,
 'inflowCents',coalesce(sum(b.amount_cents) FILTER(WHERE (b.actionable OR b.warning) AND b.amount_cents>0),0)::text,
 'outflowCents',coalesce(-sum(b.amount_cents) FILTER(WHERE (b.actionable OR b.warning) AND b.amount_cents<0),0)::text) facts
 FROM mv_bank b JOIN pg_temp.mv_bank_hash() h USING(entity_id,ll_account_id,currency)
 WHERE b.actionable OR b.warning OR b.pending_only GROUP BY b.entity_id,b.ll_account_id,b.currency,h.version
), document AS (
 SELECT entity_id,type||':'||txn_id item_key,type rule,
 encode(sha256(convert_to(jsonb_build_array(type,txn_id,due_date,remaining::text,approval_status,overdue)::text,'UTF8')),'hex') version,
 due_date date,CASE WHEN overdue THEN 0 ELSE 1 END severity,jsonb_build_object('openCents',remaining::text) facts
 FROM mv_document WHERE attention
), duplicate AS (
 SELECT entity_id,item_key,'duplicate' rule,version,first_date date,1 severity,
 jsonb_build_object('memberCount',member_count,'pairCount',pair_count) facts FROM mv_group
), floor AS (
 SELECT a.entity_id,'floor:'||a.account_id item_key,'floor' rule,
 encode(sha256(convert_to(jsonb_build_array(f.floor_cents,coalesce(n.balance,0))::text,'UTF8')),'hex') version,
 NULL::date date,2 severity,jsonb_build_object('balance',n.balance::text,'floor',f.floor_cents::text) facts
 FROM morning_floor f JOIN account a USING(org_id,account_id)
 LEFT JOIN (SELECT account_id,balance::numeric balance FROM mv_money) n USING(account_id)
 WHERE f.org_id=$1 AND f.viewer_key='owner' AND a.type='bank' AND coalesce(n.balance,0)<f.floor_cents
), alerts AS (
 SELECT f.entity_id,r.rule||':'||f.txn_id item_key,r.rule,
 encode(sha256(convert_to(jsonb_build_array(f.txn_id,f.party_key,f.family,f.m::text,r.threshold)::text,'UTF8')),'hex') version,
 f.txn_date date,1 severity,jsonb_build_object('amount',f.m::text,'kind',f.kind) facts
 FROM mv_fact f LEFT JOIN morning_company_setting s ON s.org_id=$1 AND s.entity_id=f.entity_id
 CROSS JOIN LATERAL (VALUES ('large',coalesce(s.large_threshold_cents,1000000)),('new-payee',100000::bigint)) r(rule,threshold)
 WHERE f.seed AND f.family IS NOT NULL AND f.party_key IS NOT NULL AND abs(f.m)>=r.threshold
 AND (r.rule='large' OR (f.family='outgoing-payment' AND f.first_date=f.last_date AND f.first_date=f.txn_date AND NOT EXISTS (
  SELECT 1 FROM mv_fact p WHERE p.entity_id=f.entity_id AND p.party_key=f.party_key AND p.family='outgoing-payment'
  AND p.first_date=p.last_date AND p.first_date=p.txn_date AND (p.txn_date,p.txn_id)<(f.txn_date,f.txn_id))))
), all_items AS (SELECT * FROM bank UNION ALL SELECT * FROM document UNION ALL SELECT * FROM duplicate
 UNION ALL SELECT * FROM floor UNION ALL SELECT * FROM alerts)
SELECT i.*,d.item_key IS NOT NULL dismissed FROM all_items i LEFT JOIN morning_dismissal d
 ON d.org_id=$1 AND d.viewer_key='owner' AND d.item_key=i.item_key AND d.item_version=i.version AND d.rule_version=1`,[orgId],['bankItems','documents','duplicateGroups','eligibleFacts'],1);

const safe = value => {
 const n=Number(value); if(!Number.isSafeInteger(n)) throw new Error('unsafe cents'); return n;
};
const deadlineCheck = deadline => { if(performance.now()>=deadline) throw Object.assign(new Error('computation deadline exceeded'),{code:'57014'}); };
const groupModel = r => r && ({itemKey:r.item_key,entityId:r.entity_id,partyKey:r.party_key,family:r.family,
 amountCents:safe(r.amount_cents),memberCount:r.member_count,pairCount:safe(r.pair_count),seedCount:r.seed_count,
 firstDate:r.first_date,lastDate:r.last_date,version:r.version});

const duplicateSpecs=input=>[partyFacts(input),eligibleNets(input),eligibleFacts(input),duplicateMembers(),relationshipEdges(input),
 spec('edgeIndex','CREATE INDEX ON mv_relationship_edge(a,b)',[],['relationshipEdges']),relationshipComponents(),candidateMembers(),duplicateGroups()];

export async function prototypePrepareDetail(tx,input,kind) {
 tx.morningDeadline=input.deadline;deadlineCheck(input.deadline);
 if(kind==='entries') {await execute(tx,partyFacts(input));await execute(tx,eligibleNets(input));}
 else if(kind==='bills')await execute(tx,documentQuery(input));
 else {await installGraphFunctions(tx);for(const query of duplicateSpecs(input))await execute(tx,query);}
}

export async function prototypeSummary(tx, {orgId,N,baselineAt,deadline,limit=50,thresholdCents=0}) {
 tx.morningDeadline=deadline;
 deadlineCheck(deadline);
 await tx.query("SET LOCAL statement_timeout='5s'");
 await installGraphFunctions(tx); await execute(tx,bankHashFunction);
 const input={orgId,N,baselineAt};
 await execute(tx,balanceQuery(input));
 const balances=(await execute(tx,spec('moneyVector','SELECT * FROM mv_money ORDER BY coalesce(account_id,observed_account_id)',[],['balances']))).rows;
 for(const query of [...duplicateSpecs(input),documentQuery(input),bankQuery(input),transferQuery(),attentionQuery(input)]) {
  deadlineCheck(deadline); await execute(tx,query);
 }
 const {rows:[facts]}=await execute(tx,spec('summary',`
 WITH entry_totals AS (
 SELECT count(*)::int entry_count,sum(m)::text window_net,
 count(*) FILTER(WHERE abs(m)<$2)::int small_count,
 sum(m) FILTER(WHERE abs(m)<$2)::text small_net,
 sum(m) FILTER(WHERE abs(m)<$2 AND m>0)::text small_positive,
 sum(m) FILTER(WHERE abs(m)<$2 AND m<0)::text small_negative,
 sum(m) FILTER(WHERE account_type='bank' AND m>0)::text bank_in,
 -sum(m) FILTER(WHERE account_type='bank' AND m<0) bank_out,
 -sum(m) FILTER(WHERE account_type='credit_card' AND m<0) card_charges,
 sum(m) FILTER(WHERE account_type='credit_card' AND m>0)::text card_credits
 FROM mv_net WHERE seed)
 SELECT entry_totals.*,(SELECT count(*)::int FROM mv_attention WHERE rule='duplicate' AND NOT dismissed) duplicates,
  (SELECT coalesce(sum((facts->>'needsReviewCount')::int),0)::int FROM mv_attention WHERE rule='bank' AND NOT dismissed) bank_review,
  (SELECT coalesce(sum((facts->>'pendingCount')::int),0)::int FROM mv_attention WHERE rule='bank' AND NOT dismissed) bank_pending,
  (SELECT count(*)::int FROM mv_attention WHERE rule='bill' AND NOT dismissed) bills,
  (SELECT count(*)::int FROM mv_attention WHERE rule='invoice' AND NOT dismissed) invoices,
  (SELECT count(*)::int FROM mv_transfer) transfers,
  (SELECT count(*)::int FROM mv_attention WHERE NOT dismissed) active,
  (SELECT count(*)::int FROM mv_attention WHERE dismissed) dismissed,
  (SELECT coalesce(jsonb_agg(r),'[]') FROM (SELECT * FROM mv_attention WHERE NOT dismissed ORDER BY severity,date NULLS LAST,item_key LIMIT $1) r) attention_page,
  (SELECT row_to_json(r) FROM (SELECT * FROM mv_group ORDER BY item_key LIMIT 1) r) duplicate_summary,
  (SELECT count(*)::int FROM entity e LEFT JOIN tax_profile p USING(org_id,entity_id) WHERE e.org_id=$3 AND p.entity_id IS NULL) missing_tax_profiles,
  (SELECT count(*)::int FROM entity e WHERE e.org_id=$3 AND NOT EXISTS(SELECT 1 FROM tax_return t WHERE t.org_id=e.org_id AND t.entity_id=e.entity_id)) missing_tax_periods,
  (SELECT coalesce(jsonb_agg(r),'[]') FROM (SELECT entity_id,last_pull_at,last_seen_sync_at FROM ledgerline_link WHERE org_id=$3 ORDER BY entity_id LIMIT 50) r) freshness
 FROM entry_totals
 `,[limit,thresholdCents,orgId],['attention','transfers']));
 const vector=balances.map(r=>({accountId:r.account_id??r.observed_account_id,entityId:r.entity_id??r.observed_entity_id,
  name:r.name??r.account_name,type:r.type??r.account_type,current:r.account_id!==null,
  cents:r.home && r.home!=='USD'?null:safe(r.balance??0),postedToday:safe(r.today??0),baseline:safe(r.baseline??0)}));
 const available=vector.every(r=>r.cents!==null);
 const total=available?safe(vector.reduce((s,r)=>s+BigInt(r.cents),0n)):null;
 const companies=new Map();
 for(let i=0;i<vector.length;i++) {
  const row=vector[i],source=balances[i];
  if(!companies.has(row.entityId))companies.set(row.entityId,{entityId:row.entityId,name:source.entity_name,personal:!!source.personal,
   cash:0n,cardsOwed:0n,available:0n,baseline:0n,postedToday:0n,known:true});
  const company=companies.get(row.entityId);company.known&&=row.cents!==null;
  const cents=BigInt(row.cents??0);company.available+=cents;company.baseline+=BigInt(row.baseline);company.postedToday+=BigInt(row.postedToday);
  if(row.type==='bank')company.cash+=cents;else company.cardsOwed-=cents;
 }
 const companyRows=[...companies.values()].map(c=>({...c,cash:c.known?safe(c.cash):null,cardsOwed:c.known?safe(c.cardsOwed):null,
  available:c.known?safe(c.available):null,baseline:safe(c.baseline),change:c.known?safe(c.available-c.baseline):null,postedToday:c.known?safe(c.postedToday):null}));
 const entryPage=await prototypeEntriesPage(tx,{after:null,limit,thresholdCents,deadline});
 deadlineCheck(deadline);
 return {money:{available,vector,total,companies:companyRows},counts:{bankReview:facts.bank_review,bankPending:facts.bank_pending,
  bills:facts.bills,invoices:facts.invoices,duplicates:facts.duplicates,transfers:facts.transfers,active:facts.active,dismissed:facts.dismissed},
  attentionPage:facts.attention_page,duplicateSummary:groupModel(facts.duplicate_summary),
  entries:{count:facts.entry_count,windowNet:safe(facts.window_net??0),smallCount:facts.small_count,smallNet:safe(facts.small_net??0),
   smallPositive:safe(facts.small_positive??0),smallNegative:safe(facts.small_negative??0),bankIn:safe(facts.bank_in??0),bankOut:safe(facts.bank_out??0),
   cardCharges:safe(facts.card_charges??0),cardCredits:safe(facts.card_credits??0),...entryPage},
  coverage:{missingTaxProfiles:facts.missing_tax_profiles,missingTaxPeriods:facts.missing_tax_periods},freshness:facts.freshness};
}

export async function prototypePairPage(tx,{groupKey,after=null,limit=50,deadline}) {
 tx.morningDeadline=deadline;
 deadlineCheck(deadline);
 const {rows:[r]}=await execute(tx,spec('pairPage',`
 SELECT g.member_count,g.pair_count,pg_temp.mv_pair_work(array_agg(m.txn_id ORDER BY m.day,m.txn_id),
 array_agg(m.day ORDER BY m.day,m.txn_id),array_agg(m.class ORDER BY m.day,m.txn_id),$2,$3,$4) page
 FROM mv_group g JOIN mv_candidate_member m USING(component) WHERE g.item_key=$1 GROUP BY g.member_count,g.pair_count`,
 [groupKey,after?.lo??null,after?.hi??null,limit],['duplicateGroups','pairFunction'],1));
 deadlineCheck(deadline); return r?{memberCount:r.member_count,pairCount:safe(r.pair_count),...r.page}:{gone:true};
}

export async function prototypeMemberPage(tx,{groupKey,after=null,limit=50,deadline}) {
 tx.morningDeadline=deadline;
 if(limit<1||limit>50) throw new Error('page size'); deadlineCheck(deadline);
 const {rows:[result]}=await execute(tx,spec('memberPage',`SELECT g.member_count,g.pair_count,coalesce((SELECT jsonb_agg(p) FROM (
 SELECT m.txn_id "txnId",m.txn_date date,m.m::text "mCents",m.type,m.kind,m.partition_label "partitionLabel"
 FROM mv_candidate_member m WHERE m.component=g.component
 AND ($2::date IS NULL OR (m.txn_date,m.txn_id)>($2::date,$3::bigint))
 ORDER BY m.txn_date,m.txn_id LIMIT $4) p),'[]') members FROM mv_group g WHERE g.item_key=$1`,
 [groupKey,after?.date??null,after?.txnId??null,limit+1],['duplicateGroups']));
 if(!result)return {gone:true};const rows=result.members;
 const more=rows.length>limit; const members=rows.slice(0,limit); const last=members.at(-1);
 return {memberCount:result.member_count,pairCount:safe(result.pair_count),members,next:more?{date:last.date,txnId:last.txnId}:null};
}

export async function prototypeEntriesPage(tx,{after=null,limit=50,thresholdCents=0,deadline}) {
 tx.morningDeadline=deadline;
 if(limit<1||limit>50) throw new Error('page size'); deadlineCheck(deadline);
 const {rows:[result]}=await execute(tx,spec('entriesPage',`WITH full_set AS MATERIALIZED(SELECT * FROM mv_net WHERE seed),
 totals AS (SELECT count(*)::int count,sum(m)::text "windowNet",count(*) FILTER(WHERE abs(m)<$1)::int "smallCount",
 sum(m) FILTER(WHERE abs(m)<$1)::text "smallNet" FROM full_set),
 page AS (SELECT entity_id "entityId",txn_id "txnId",account_id "accountId",
 txn_date date,m::text "netCents",kind FROM full_set WHERE abs(m)>=$1
 AND ($2::date IS NULL OR txn_date<$2::date OR (txn_date=$2::date AND (entity_id,txn_id,account_id)>($3,$4,$5)))
 ORDER BY txn_date DESC,entity_id,txn_id,account_id LIMIT $6)
 SELECT totals.*,coalesce((SELECT jsonb_agg(page) FROM page),'[]') page FROM totals`,[thresholdCents,after?.date??null,after?.entityId??null,
 after?.txnId??null,after?.accountId??null,limit+1],['eligibleNets']));
 const rows=result.page;
 const more=rows.length>limit; const page=rows.slice(0,limit); const last=page.at(-1);
 return {count:result.count,windowNet:safe(result.windowNet??0),smallCount:result.smallCount,smallNet:safe(result.smallNet??0),
  page,next:more?{date:last.date,entityId:last.entityId,txnId:last.txnId,accountId:last.accountId}:null};
}

export async function prototypeBillsPage(tx,{after=null,limit=50,deadline}) {
 tx.morningDeadline=deadline;
 if(limit<1||limit>50) throw new Error('page size'); deadlineCheck(deadline);
 const {rows:[result]}=await execute(tx,spec('billsPage',`WITH full_set AS MATERIALIZED(
 SELECT t.* FROM mv_document t WHERE type='bill' AND attention AND NOT EXISTS(
 SELECT 1 FROM morning_dismissal d WHERE d.org_id=t.org_id AND d.viewer_key='owner' AND d.item_key='bill:'||t.txn_id
 AND d.rule_version=1 AND d.item_version=encode(sha256(convert_to(jsonb_build_array(t.type,t.txn_id,t.due_date,t.remaining::text,t.approval_status,t.overdue)::text,'UTF8')),'hex'))
 ), page AS (SELECT txn_id "txnId",due_date due,remaining::text "openCents"
 FROM full_set WHERE ($1::date IS NULL OR (due_date,txn_id)>($1::date,$2))
 ORDER BY due_date,txn_id LIMIT $3)
 SELECT count(*)::int count,sum(remaining)::text total,coalesce((SELECT jsonb_agg(page) FROM page),'[]') page FROM full_set`,
 [after?.due??null,after?.txnId??null,limit+1],['documents']));
 const rows=result.page;
 const more=rows.length>limit; const page=rows.slice(0,limit); const last=page.at(-1);
 return {count:result.count,total:safe(result.total??0),page,next:more?{due:last.due,txnId:last.txnId}:null};
}

const completedOracles={};
export const oracleEvidence=()=>structuredClone(completedOracles);

function* datesOf(n, max, prefix=[]) {
 if(prefix.length===n) { yield prefix; return; }
 for(let d=prefix.at(-1)??0;d<=max;d++) yield* datesOf(n,max,[...prefix,d]);
}
function* codesOf(n,base) {
 for(let code=0;code<base**n;code++) {
  let x=code; const values=[];
  for(let i=0;i<n;i++) {values.push(x%base);x=Math.floor(x/base);}
  yield values;
 }
}
function exhaustiveGraph(days,classes) {
 const edges=[]; const adjacent=days.map(()=>[]);
 for(let i=0;i<days.length;i++) for(let j=i+1;j<days.length;j++) {
  if(Math.abs(days[i]-days[j])<=5 && classes[i]!==classes[j]) {
   edges.push([i+1,j+1]); adjacent[i].push(j);adjacent[j].push(i);
  }
 }
 const labels=days.map(()=>0);
 for(let i=0;i<days.length;i++) if(!labels[i]) {
  const stack=[i]; labels[i]=i+1;
  while(stack.length) { const a=stack.pop();for(const b of adjacent[a]) if(!labels[b]) {labels[b]=i+1;stack.push(b);} }
 }
 return {edges,labels};
}

export async function duplicateOracle(tx) {
 const result={cases:0,componentMismatches:0,countMismatches:0,pageMismatches:0,seedMismatches:0};
 const sparse=(await tx.query(`SELECT pg_temp.mv_components(ARRAY[1,1000000000000,9000000000000]::bigint[],
  ARRAY[1]::bigint[],ARRAY[1000000000000]::bigint[]) labels`)).rows[0].labels.map(Number);
 if(JSON.stringify(sparse)!==JSON.stringify([1,1,9000000000000]))result.componentMismatches++;
 let batch=[];
 async function flush() {
  if(!batch.length)return;
  const {rows}=await tx.query({text:`WITH cases AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id int,days int[],classes int[],edge_a bigint[],edge_b bigint[],after_lo bigint,after_hi bigint))
   SELECT a.id,c.labels,c.pairs,pg_temp.mv_components(ARRAY(SELECT generate_series(1,cardinality(a.days))::bigint),a.edge_a,a.edge_b) relationship_labels,
    pg_temp.mv_pair_work(ARRAY(SELECT generate_series(1,cardinality(a.days))::bigint),
    a.days,a.classes::bigint[],a.after_lo,a.after_hi,50) page
   FROM cases a CROSS JOIN LATERAL (SELECT array_agg(component ORDER BY pos) labels,sum(pair_contribution)::int pairs
    FROM pg_temp.mv_candidates(a.days,a.classes)) c`,values:[JSON.stringify(batch)],query_timeout:300_000});
  for(const row of rows) {
   const c=batch[row.id], expected=exhaustiveGraph(c.days,c.classes);
   if(JSON.stringify(row.relationship_labels.map(Number))!==JSON.stringify(c.classes.map(v=>c.classes.indexOf(v)+1)))result.componentMismatches++;
   if(JSON.stringify(row.labels)!==JSON.stringify(expected.labels)) result.componentMismatches++;
   if(row.pairs!==expected.edges.length) result.countMismatches++;
   const suffix=expected.edges.filter(([lo,hi])=>c.after_lo===null||lo>c.after_lo||(lo===c.after_lo&&hi>c.after_hi));
   if(JSON.stringify(row.page.pairs.map(p=>[p.lo,p.hi]))!==JSON.stringify(suffix)||row.page.next!==null) result.pageMismatches++;
   for(let seed=-1;seed<c.days.length;seed++) {
    const groups=labels=>[...new Set(labels)].map(label=>labels.flatMap((v,i)=>v===label?[i+1]:[]))
     .filter(m=>m.length>1&&m.includes(seed+1));
    if(JSON.stringify(groups(row.labels))!==JSON.stringify(groups(expected.labels))) result.seedMismatches++;
   }
  }
  result.cases+=batch.length; batch=[];
  if(result.cases%131072===0)console.error(`duplicate oracle: ${result.cases} cases`);
 }
 for(let n=1;n<=6;n++) for(const days of datesOf(n,7)) for(const raw of codesOf(n,3)) {
  const distinct=[...new Set(raw)].sort(); const classes=raw.map(c=>distinct.indexOf(c)+1);
  const cursor=(result.cases+batch.length)%3;
  const edge_a=[],edge_b=[];
  for(let i=0;i<n;i++){const first=classes.indexOf(classes[i]);if(first!==i){edge_a.push(first+1);edge_b.push(i+1);}}
  batch.push({id:batch.length,days,classes,edge_a,edge_b,after_lo:cursor===0?null:cursor===1?1:n-1,after_hi:cursor===0?null:cursor===1?Math.min(n,3):n});
  if(batch.length===2048) await flush();
 }
 await flush();completedOracles.duplicate=result;return result;
}

export async function transferOracle(tx) {
 const result={cases:0,degreeMismatches:0,partnerMismatches:0,suggestionMismatches:0};
 let batch=[];
 // Use exactly the production degree CTE; only its input relation is the small oracle data.
 const production=transferQuery().text;
 const cte=production.slice(production.indexOf('WITH leg AS'),production.indexOf('\nSELECT l.txn_id out_txn'));
 async function flush() {
  if(!batch.length)return;
  const legs=batch.flatMap((c,id)=>c.days.map((day,i)=>({txn_id:id*10+i,account_id:i,entity_id:Math.floor(c.code[i]/2)+1,
   account_type:'bank',m:(c.code[i]%2?1:-1)*(id+1)*100,first_date:`2026-01-0${day+1}`,last_date:`2026-01-0${day+1}`,
   type:'journal_entry',txn_date:`2026-01-0${day+1}`,created_at:'2026-01-01',updated_at:'2026-01-01',customer_id:null,vendor_id:null,seed:true,kind:'added'})));
  const input=`SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(txn_id bigint,account_id bigint,entity_id bigint,account_type text,m numeric,
   first_date date,last_date date,type text,txn_date date,created_at timestamptz,updated_at timestamptz,customer_id bigint,vendor_id bigint,seed bool,kind text)`;
  const {rows}=await tx.query({text:cte.replace('FROM mv_net',`FROM (${input}) mv_net`)+
   ` SELECT d.txn_id,d.degree,r.txn_id partner FROM degree d LEFT JOIN degree r ON d.degree=1 AND r.ordinal=d.partner ORDER BY d.txn_id`,
   values:[JSON.stringify(legs)],query_timeout:300_000});
  const by=new Map(rows.map(r=>[r.txn_id,r]));
  for(let id=0;id<batch.length;id++) {
   const c=batch[id];const degrees=[],partners=[];
   for(let i=0;i<c.days.length;i++) {
    const peers=c.days.flatMap((d,j)=>i!==j&&Math.abs(c.days[i]-d)<=3&&c.code[i]%2!==c.code[j]%2&&
      Math.floor(c.code[i]/2)!==Math.floor(c.code[j]/2)?[j]:[]);
    degrees.push(peers.length);partners.push(peers.length===1?peers[0]:null);
    const row=by.get(id*10+i);
    if(row.degree!==peers.length)result.degreeMismatches++;
    if(row.partner!==(peers.length===1?id*10+peers[0]:null))result.partnerMismatches++;
   }
   const expected=[],actual=[];
   for(let i=0;i<c.days.length;i++) if(c.code[i]%2===0) {
    if(degrees[i]===1&&degrees[partners[i]]===1)expected.push([i,partners[i]]);
    const row=by.get(id*10+i),other=by.get(row.partner);
    if(row.degree===1&&other?.degree===1&&other.partner===row.txn_id)actual.push([i,other.txn_id%10]);
   }
   if(JSON.stringify(actual)!==JSON.stringify(expected))result.suggestionMismatches++;
  }
  result.cases+=batch.length;batch=[];
  if(result.cases%65536===0)console.error(`transfer oracle: ${result.cases} cases`);
 }
 for(let n=1;n<=5;n++) for(const days of datesOf(n,4)) for(const code of codesOf(n,6)) {
  batch.push({days,code}); if(batch.length===512)await flush();
 }
 await flush();completedOracles.transfer=result;return result;
}
