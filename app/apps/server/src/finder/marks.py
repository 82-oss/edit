# marks.py <tag> <media>: the file's laid-over words (labels that stay put, marks that wander), from the survey and the
# scene-change test -> <media>.marks.json
import sys,json,re,collections,difflib,numpy as np
from events import STAMP
from zone import AXON
def find(tag,mid,T=18):
    rows=[json.loads(l) for l in open(f'{tag}/scan/{mid}.jsonl')]
    Z=json.load(open(f'{tag}/scan/{mid}.zone.json'))
    z=np.load(f'{tag}/scan/{mid}.thumbs.npz'); th={int(f):t.astype(np.int16) for f,t in zip(z['f'],z['t'])}
    def instamp(b): return any(b[0]>=s[0]-60 and b[2]<=s[2]+60 and b[1]>=s[1]-12 and b[3]<=s[3]+12 for s in Z['stamps'])
    # A two-letter word counts only where it stays in one place for a good part of the file: a channel's initials (Nov 23,
    # "RC" in red in the middle of an interrogation room, read in 4,930 of 5,000 looks and dropped for being short).
    short=collections.Counter()
    for r in rows:
        short.update({(re.sub(r'[^a-z0-9]','',L[4].lower()),L[0]//24,L[1]//24) for L in r['lines'] if L[5]>=0.5 and len(re.sub(r'[^a-z0-9]','',L[4].lower()))==2})
    initials={k for (k,_,_),n in short.items() if n>=max(30,0.3*len(rows))}
    words=collections.defaultdict(list)
    for r in rows:
        for L in r['lines']:
            k=re.sub(r'[^a-z0-9]','',L[4].lower())
            if (len(k)>=3 or k in initials) and L[5]>=0.5 and not STAMP.search(L[4]) and not AXON.search(L[4]) and not instamp(L): words[k].append((r['f'],L))
    gs=[]
    for k in sorted(words,key=lambda k:-len(words[k])):
        for g in gs:
            if (k==g['key'] if min(len(k),len(g['key']))<3 else difflib.SequenceMatcher(None,k,g['key']).ratio()>0.7): g['v']+=words[k]; break
        else:
            if len(gs)<300: gs.append({'key':k,'v':list(words[k])})
    out=[]
    for g in gs:
        if len(g['v'])<30: continue
        at=collections.defaultdict(list)
        for f,L in g['v']: at[f].append(L)
        held=moved=gone=0
        for f in sorted(at):
            if f+10 not in th or f not in th or float(np.abs(th[f+10]-th[f]).mean())<=T: continue
            nxt=at.get(f+10,[])
            if any(abs((a[1]+a[3])-(b[1]+b[3]))<=24 and min(a[2],b[2])-max(a[0],b[0])>0.3*min(a[2]-a[0],b[2]-b[0]) for a in at[f] for b in nxt): held+=1
            elif nxt: moved+=1
            else: gone+=1
        v=g['v']; hs=np.array([L[3]-L[1] for _,L in v]); ws=np.array([L[2]-L[0] for _,L in v])
        cells=collections.Counter((L[0]//40,L[1]//40) for _,L in v)
        m={'key':g['key'],'n':len(v),'cells':len(cells),'held':held,'moved':moved,'gone':gone,'w':float(np.percentile(ws,75)),'h':float(np.median(hs))}
        w75=m['w']; fullc=collections.Counter(((L[0]+L[2])//80,(L[1]+L[3])//80) for _,L in v if abs((L[2]-L[0])-w75)<0.12*w75)
        still=len(cells)<=6 or sum(c for _,c in cells.most_common(4))>=0.9*len(v) or (sum(fullc.values())>=10 and sum(c for _,c in fullc.most_common(2))>=0.85*sum(fullc.values()))
        zone=Z['zone']; H=Z['H']
        inzone=zone is not None and np.mean([(zone[0]*H<=(L[1]+L[3])/2<=zone[1]*H) for _,L in v])>0.5
        if inzone and not still: continue   # a caption's word that comes back ("you", "(Radio Chatter)"): the captions' own pass takes it
        if held>=4 and held>=3*moved: m['kind']='label' if still else 'roamer'
        elif still and held+moved+gone<4 and np.percentile(hs,75)/max(1,np.percentile(hs,25))<1.25: m['kind']='unsure'   # one place, never tested by a change of scene
        else: continue
        m['reads']=[[f,*L[:4]] for f,L in sorted(v,key=lambda x:x[0]) if abs((L[3]-L[1])-m['h'])<0.4*m['h']]
        out.append(m)
    return out
if __name__=='__main__':
    for mid in sys.argv[2:]:
        ms=find(sys.argv[1],mid); json.dump(ms,open(f'{sys.argv[1]}/scan/{mid}.marks.json','w'))
        for m in ms: print(mid,m['kind'],m['key'][:30],'n',m['n'],'places',m['cells'],'held/moved/gone',m['held'],m['moved'],m['gone'],'size',round(m['w']),round(m['h']))
