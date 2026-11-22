# glide.py <tag> <media> [ext] [more]: a wandering mark's path: where the reader (even a piece of its name) or a strong
# match of its look saw it, joined where the sightings are no more than 15 s apart (it glides slowly), held a little
# past the first and last of a run; nothing where nobody saw it -> <media>.roam.masks.json
import sys,json,re,difflib,os,numpy as np
def anchors(tag,mid,m,files):
    A={}; key=m['key']; cw=m['w']/len(key)
    for fn in files:
        if not os.path.exists(fn): continue
        for l in open(fn):
            r=json.loads(l)
            for L in r['lines']:
                # a read of part of its name ("STFLIX") still says where the whole mark is: by which letters it read
                k=re.sub(r'[^a-z0-9]','',L[4].lower())
                if len(k)<3 or abs((L[3]-L[1])-m['h'])>0.6*m['h']: continue
                mb=max(difflib.SequenceMatcher(None,k,key).get_matching_blocks(),key=lambda x:x.size)
                if mb.size<3 or mb.size<0.6*len(k): continue
                A[r['f']]=(L[0]-(mb.b-mb.a)*cw+m['w']/2,(L[1]+L[3])/2)
    return A
def path(A,W,H,ext,GAP=450,HOLD=20,lo=None,hi=None):
    ks=sorted(A); P=np.array([A[k] for k in ks]).reshape(-1,2); keep=np.ones(len(ks),bool)
    for i in range(len(ks)):   # a sighting far from where its neighbours put it is a misread
        js=[j for j in range(max(0,i-3),min(len(ks),i+4)) if j!=i and abs(ks[j]-ks[i])<=90]
        if js and sum(np.hypot(*(P[j]-P[i]))<=12+1.5*abs(ks[j]-ks[i]) for j in js)<0.5*len(js): keep[i]=False
    ks=[k for k,q in zip(ks,keep) if q]; P=P[keep]; out=[]
    def box(f,p0,p1,pad): out.append([f,f+2,max(0,int(min(p0[0],p1[0])+ext[0]-pad)),max(0,int(min(p0[1],p1[1])+ext[1]-pad)),min(W,int(max(p0[0],p1[0])+ext[2]+pad)),min(H,int(max(p0[1],p1[1])+ext[3]+pad)),'mark'])
    for i in range(len(ks)):
        a=ks[i]; b=ks[i+1] if i+1<len(ks) else None; pv=ks[i-1] if i>0 else None
        if b is not None and b-a<=GAP:
            for f in range(a,b,3):
                u0=(f-a)/(b-a); u1=min(1,(f+3-a)/(b-a)); box(f,P[i]+u0*(P[i+1]-P[i]),P[i]+u1*(P[i+1]-P[i]),24+0.2*min(f-a,b-f))
        else:   # the last of a run: held where it was, the box growing as it may have glided on
            end=a+HOLD if hi is None else hi
            for f in range(a,end+1,3): box(f,P[i],P[i],24+1.0*min(f-a,150))
        if pv is None or a-pv>GAP:
            start=a-HOLD if lo is None else lo
            for f in range(start,a,3): box(f,P[i],P[i],24+1.0*min(a-f,150))
    return out,len(ks)
def main(tag,mid,ext,more=False):
    Z=json.load(open(f'{tag}/scan/{mid}.zone.json')); W,H=Z['W'],Z['H']
    allm=json.load(open(f'{tag}/scan/{mid}.marks.json')); labels=[x['key'] for x in allm if x['kind']=='label']
    # a piece of a label's name read on its own ("mtube" of "bodycamtubes") is that label, not a mark that wanders
    rm=sorted([x for x in allm if x['kind']=='roamer' and not any(x['key'] in k or difflib.SequenceMatcher(None,x['key'],k).ratio()>0.55 for k in labels)],key=lambda x:-x['n'])
    if not rm:
        json.dump([],open(f'{tag}/scan/{mid}.roam.masks.json','w')); return
    m=rm[0]
    if ext is None: ext=[-int(0.55*m['w']),-int(0.9*m['h']),int(0.55*m['w']),int(0.9*m['h'])]
    # a learned reach far past the words is the scene's own still edges, not the mark: the words' box and a little then
    if (ext[2]-ext[0])*(ext[3]-ext[1])>5*m['w']*m['h'] or ext[2]-ext[0]>1.7*m['w']: ext=[-int(0.55*m['w']),-int(0.9*m['h']),int(0.55*m['w']),int(0.9*m['h'])]
    A=anchors(tag,mid,m,[f'{tag}/scan/{mid}.jsonl']+([f'{tag}/scan/{mid}.left5.jsonl'] if more else []))
    if os.path.exists(f'{tag}/scan/{mid}.roam.raw.json'):
        R=json.load(open(f'{tag}/scan/{mid}.roam.raw.json'))
        for k,p,s in zip(R['ks'],R['P'],R['S']):
            if s>=0.4: A[k]=tuple(p)
    out,n=path(A,W,H,ext); json.dump(out,open(f'{tag}/scan/{mid}.roam.masks.json','w'))
    print(mid,m['key'],n,'sightings kept; path covers',len(out)*3,'frames')
if __name__=='__main__':
    e=f'{sys.argv[1]}/scan/{sys.argv[2]}.roam.ext.json'
    main(sys.argv[1],sys.argv[2],json.loads(sys.argv[3]) if len(sys.argv)>3 and sys.argv[3].startswith('[') else (json.load(open(e)) if os.path.exists(e) else None),'more' in sys.argv)
